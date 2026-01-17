import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BUILD_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig } from '../../config/effort.js';
import {
  checkLoopCostLimit,
  checkPhaseCostLimit,
  formatCostExceededError,
} from '../../costs/index.js';
import type { LoopManager } from '../../loops/manager.js';
import { detectStuck, updateStuckIndicators } from '../../loops/stuck-detection.js';
import type {
  LoopState,
  OrchestratorState,
  ReviewIssue,
  Task,
  TaskGraph,
} from '../../types/index.js';

export function buildPromptWithFeedback(
  task: Task,
  reviewIssues: ReviewIssue[],
  iteration: number,
  maxIterations: number
): string {
  let prompt = '';

  // Filter issues for this task
  const relevantIssues = reviewIssues.filter((i) => i.taskId === task.id);

  if (relevantIssues.length > 0) {
    prompt += '## Previous Review Feedback\n';
    prompt += 'Your last implementation had these issues. Fix them:\n\n';
    for (const issue of relevantIssues) {
      const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      prompt += `- **${location}** (${issue.type}): ${issue.description}\n`;
      prompt += `  Fix: ${issue.suggestion}\n\n`;
    }
  }

  prompt += `${BUILD_PROMPT}

## Current Task:
ID: ${task.id}
Title: ${task.title}
Description: ${task.description}

## Iteration: ${iteration}/${maxIterations}`;

  return prompt;
}

export function getNextParallelGroup(graph: TaskGraph, completedTasks: string[]): string[] | null {
  for (const group of graph.parallelGroups) {
    const allComplete = group.every((id) => completedTasks.includes(id));
    if (!allComplete) {
      // Return tasks from this group that aren't complete
      return group.filter((id) => !completedTasks.includes(id));
    }
  }
  return null;
}

export function canStartGroup(
  taskIds: string[],
  completedTasks: string[],
  allTasks: Task[]
): boolean {
  for (const taskId of taskIds) {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) continue;

    const depsComplete = task.dependencies.every((dep) => completedTasks.includes(dep));
    if (!depsComplete) return false;
  }
  return true;
}

export interface BuildResult {
  completedTasks: string[];
  activeLoops: LoopState[];
  needsReview: boolean;
  stuck: boolean;
  pendingConflict?: {
    loopId: string;
    taskId: string;
    conflictFiles: string[];
  };
  loopCosts: Record<string, number>; // loopId -> cost for this iteration
}

export async function executeBuildIteration(
  state: OrchestratorState,
  loopManager: LoopManager,
  onLoopOutput?: (loopId: string, text: string) => void
): Promise<BuildResult> {
  const graph = state.taskGraph!;
  const dbPath = join(state.stateDir, 'state.db');
  const effortConfig = getEffortConfig(state.effort);

  // Check if build phase has exceeded its cost limit
  const phaseCostCheck = checkPhaseCostLimit('build', state.costs, state.costLimits);
  if (phaseCostCheck.exceeded) {
    const errorMsg = formatCostExceededError(phaseCostCheck);
    state.context.errors.push(errorMsg);
    // Mark all active loops as failed due to phase cost limit
    for (const loop of loopManager.getActiveLoops()) {
      loopManager.updateLoopStatus(loop.loopId, 'failed');
    }
    return {
      completedTasks: state.completedTasks,
      activeLoops: loopManager.getAllLoops(),
      needsReview: false,
      stuck: true,
      loopCosts: {},
    };
  }

  // Check for loops that have exceeded cost limits
  for (const loop of loopManager.getActiveLoops()) {
    const costCheck = checkLoopCostLimit(loop.loopId, state.costs, state.costLimits);
    if (costCheck.exceeded) {
      const errorMsg = formatCostExceededError(costCheck);
      state.context.errors.push(errorMsg);
      loopManager.updateLoopStatus(loop.loopId, 'failed');
    }
  }

  // Check for stuck loops
  for (const loop of loopManager.getActiveLoops()) {
    const stuckResult = detectStuck(loop, { stuckThreshold: effortConfig.stuckThreshold });
    if (stuckResult) {
      loopManager.updateLoopStatus(loop.loopId, 'stuck');
      return {
        completedTasks: state.completedTasks,
        activeLoops: loopManager.getAllLoops(),
        needsReview: true,
        stuck: true,
        loopCosts: {},
      };
    }
  }

  // Spawn new loops for available tasks
  const nextGroup = getNextParallelGroup(graph, state.completedTasks);
  if (nextGroup && canStartGroup(nextGroup, state.completedTasks, state.tasks)) {
    while (loopManager.canSpawnMore() && nextGroup.length > 0) {
      const taskId = nextGroup.shift()!;
      const loop = await loopManager.createLoop([taskId], state.tasks);
      loopManager.updateLoopStatus(loop.loopId, 'running');
    }
  }

  // Execute one iteration for each active loop
  const loopPromises = loopManager.getActiveLoops().map(async (loop) => {
    const task = state.tasks.find((t) => t.id === loop.taskIds[0])!;
    const prompt = buildPromptWithFeedback(
      task,
      state.context.reviewIssues ?? [],
      loop.iteration + 1,
      loop.maxIterations
    );

    // Use worktree path if available, otherwise fall back to process.cwd()
    const loopCwd = loop.worktreePath || process.cwd();
    const config = createAgentConfig('build', loopCwd, state.runId, dbPath);

    let output = '';
    let hasError = false;
    let errorMessage: string | null = null;
    let costUsd = 0;

    try {
      for await (const message of query({
        prompt,
        options: {
          cwd: loopCwd,
          allowedTools: config.allowedTools,
          maxTurns: 10, // Single iteration limit
        },
      })) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block) {
              output += block.text;
              onLoopOutput?.(loop.loopId, block.text);
              loopManager.appendOutput(loop.loopId, block.text);
            }
          }
        }
        if (message.type === 'result') {
          costUsd = (message as any).total_cost_usd || 0;
        }
      }

      // Check for completion signal
      if (output.includes('TASK_COMPLETE')) {
        // Merge worktree if using worktrees
        const worktreeManager = loopManager.getWorktreeManager();
        if (loop.worktreePath && worktreeManager) {
          const mergeResult = await worktreeManager.merge(loop.loopId);

          if (mergeResult.status === 'conflict') {
            // Return conflict info for orchestrator to handle in conflict phase
            return {
              loopId: loop.loopId,
              taskId: task.id,
              completed: false,
              costUsd,
              conflict: {
                loopId: loop.loopId,
                taskId: task.id,
                conflictFiles: mergeResult.conflictFiles,
              },
            };
          }

          // Cleanup worktree on successful merge
          await worktreeManager.cleanup(loop.loopId);
        }

        loopManager.updateLoopStatus(loop.loopId, 'completed');
        return { loopId: loop.loopId, taskId: task.id, completed: true, costUsd };
      }

      // Check for stuck signal
      if (output.includes('TASK_STUCK:')) {
        const stuckMatch = output.match(/TASK_STUCK:\s*(.+)/);
        errorMessage = stuckMatch?.[1] || 'Unknown reason';
        hasError = true;
      }
    } catch (e) {
      hasError = true;
      errorMessage = String(e);
    }

    loopManager.incrementIteration(loop.loopId);
    updateStuckIndicators(loop, errorMessage, !hasError);

    return { loopId: loop.loopId, taskId: task.id, completed: false, costUsd };
  });

  const results = await Promise.all(loopPromises);
  const newlyCompleted = results.filter((r) => r.completed).map((r) => r.taskId);

  // Aggregate loop costs from this iteration
  const loopCosts: Record<string, number> = {};
  for (const result of results) {
    if ('costUsd' in result) {
      loopCosts[result.loopId] = result.costUsd;
    }
  }

  // Check for conflicts - return first one found for orchestrator to handle
  const conflictResult = results.find((r) => 'conflict' in r && r.conflict);
  if (conflictResult && 'conflict' in conflictResult && conflictResult.conflict) {
    return {
      completedTasks: [...state.completedTasks, ...newlyCompleted],
      activeLoops: loopManager.getAllLoops(),
      needsReview: false,
      stuck: false,
      pendingConflict: conflictResult.conflict,
      loopCosts,
    };
  }

  // Check if any loop needs review
  const needsReview = loopManager
    .getActiveLoops()
    .some((loop) => loopManager.needsReview(loop.loopId));

  return {
    completedTasks: [...state.completedTasks, ...newlyCompleted],
    activeLoops: loopManager.getAllLoops(),
    needsReview,
    stuck: false,
    loopCosts,
  };
}
