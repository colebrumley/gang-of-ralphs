import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BUILD_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import {
  checkLoopCostLimit,
  checkPhaseCostLimit,
  formatCostExceededError,
} from '../../costs/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { IdleTimeoutError, createIdleMonitor } from '../../loops/idle-timeout.js';
import type { LoopManager } from '../../loops/manager.js';
import { detectStuck, updateStuckIndicators } from '../../loops/stuck-detection.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import type {
  LoopState,
  OrchestratorState,
  ReviewIssue,
  Task,
  TaskGraph,
} from '../../types/index.js';
import { executeLoopReview } from './review.js';

export function buildPromptWithFeedback(
  task: Task,
  reviewIssues: ReviewIssue[],
  iteration: number,
  maxIterations: number
): string {
  // Static content first for API-level prompt caching
  let prompt = BUILD_PROMPT;

  // Variable content after the static prefix
  prompt += `

## Current Task:
ID: ${task.id}
Title: ${task.title}
Description: ${task.description}

## Iteration: ${iteration}/${maxIterations}`;

  // Filter issues for this task
  const relevantIssues = reviewIssues.filter((i) => i.taskId === task.id);

  if (relevantIssues.length > 0) {
    prompt += '\n\n## Previous Review Feedback\n';
    prompt += 'Your last implementation had these issues. Fix them:\n\n';
    for (const issue of relevantIssues) {
      const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      prompt += `- **${location}** (${issue.type}): ${issue.description}\n`;
      prompt += `  Fix: ${issue.suggestion}\n\n`;
    }
  }

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
  onLoopCreated?: (loop: LoopState) => void,
  onLoopOutput?: (loopId: string, text: string) => void,
  tracer?: DebugTracer
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
    const stuckResult = detectStuck(loop, { stuckThreshold: effortConfig.stuckThreshold }, tracer);
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

  // Restart interrupted loops (from previous process termination)
  for (const loop of loopManager.getAllLoops()) {
    if (loop.status === 'interrupted') {
      tracer?.logLoopStatusChange(loop.loopId, 'running', loop.taskIds);
      loopManager.updateLoopStatus(loop.loopId, 'running');
    }
  }

  // Spawn new loops for available tasks
  const nextGroup = getNextParallelGroup(graph, state.completedTasks);
  if (nextGroup && canStartGroup(nextGroup, state.completedTasks, state.tasks)) {
    while (loopManager.canSpawnMore() && nextGroup.length > 0) {
      const taskId = nextGroup.shift()!;
      const loop = await loopManager.createLoop([taskId], state.tasks);
      loopManager.updateLoopStatus(loop.loopId, 'running');
      // Notify TUI immediately so it can display the loop and receive output updates
      onLoopCreated?.(loop);
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
    const model = getModelId(effortConfig.models.build);
    const config = createAgentConfig('build', loopCwd, state.runId, dbPath, model);

    let output = '';
    let hasError = false;
    let errorMessage: string | null = null;
    let costUsd = 0;
    const startTime = Date.now();

    // Buffers for accumulating partial lines from streaming output
    let lineBuffer = '';
    let thinkingLineBuffer = '';

    // Start streaming writer
    const writer = tracer?.startAgentCall({
      phase: 'build',
      loopId: loop.loopId,
      iteration: loop.iteration + 1,
      prompt,
    });

    // Create idle monitor to detect hung agents
    const idleMonitor = createIdleMonitor();

    try {
      // Race the query loop against the idle timeout
      await Promise.race([
        (async () => {
          for await (const message of query({
            prompt,
            options: {
              cwd: loopCwd,
              allowedTools: config.allowedTools,
              maxTurns: 10_000, // Emergency backstop only; idle timeout is the real limit
              model: config.model,
              includePartialMessages: true,
              mcpServers: {
                'sq-db': {
                  command: 'node',
                  args: [MCP_SERVER_PATH, state.runId, dbPath],
                },
              },
            },
          })) {
            // Record activity on any message to reset idle timeout
            idleMonitor.recordActivity();
            loopManager.updateLastActivity(loop.loopId);

            // Handle tool progress messages to show activity during tool execution
            if (message.type === 'tool_progress') {
              const toolName = (message as any).tool_name || 'tool';
              const elapsed = (message as any).elapsed_time_seconds || 0;
              const progressText = `[tool] ${toolName} (${elapsed.toFixed(1)}s)`;
              writer?.appendOutput(`${progressText}\n`);
              onLoopOutput?.(loop.loopId, `${progressText}\n`);
              loopManager.appendOutput(loop.loopId, progressText);
            }
            // Handle streaming events for real-time thinking output
            if (message.type === 'stream_event') {
              const event = message.event as any;
              // Handle tool_use content block start to show when a tool begins
              if (
                event.type === 'content_block_start' &&
                event.content_block?.type === 'tool_use'
              ) {
                const toolName = event.content_block.name || 'tool';
                const toolText = `[tool] starting ${toolName}`;
                writer?.appendOutput(`${toolText}\n`);
                onLoopOutput?.(loop.loopId, `${toolText}\n`);
                loopManager.appendOutput(loop.loopId, toolText);
              }
              // Handle thinking delta events
              if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
                const thinkingText = event.delta.thinking || '';
                if (thinkingText) {
                  writer?.appendOutput(thinkingText);
                  onLoopOutput?.(loop.loopId, `[thinking] ${thinkingText}`);

                  // Buffer thinking text and only output complete lines to TUI
                  thinkingLineBuffer += thinkingText;
                  const lines = thinkingLineBuffer.split('\n');
                  thinkingLineBuffer = lines.pop() || '';
                  for (const line of lines) {
                    loopManager.appendOutput(loop.loopId, `[thinking] ${line}`);
                  }
                }
              }
              // Handle text delta events
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                const textDelta = event.delta.text || '';
                if (textDelta) {
                  output += textDelta;
                  writer?.appendOutput(textDelta);
                  onLoopOutput?.(loop.loopId, textDelta);

                  // Buffer text and only output complete lines to TUI
                  lineBuffer += textDelta;
                  const lines = lineBuffer.split('\n');
                  // Keep the last part (incomplete line) in the buffer
                  lineBuffer = lines.pop() || '';
                  // Output complete lines
                  for (const line of lines) {
                    loopManager.appendOutput(loop.loopId, line);
                  }
                }
              }
            }
            if (message.type === 'assistant' && message.message?.content) {
              for (const block of message.message.content) {
                // Only handle text blocks that weren't already streamed
                if ('text' in block && !output.includes(block.text)) {
                  output += block.text;
                  writer?.appendOutput(block.text);
                  onLoopOutput?.(loop.loopId, block.text);
                  loopManager.appendOutput(loop.loopId, block.text);
                }
                // Capture thinking blocks to show activity during extended thinking
                if (
                  'type' in block &&
                  block.type === 'thinking' &&
                  'thinking' in block &&
                  typeof block.thinking === 'string'
                ) {
                  const thinkingText = `[thinking] ${block.thinking}\n`;
                  writer?.appendOutput(thinkingText);
                  onLoopOutput?.(loop.loopId, thinkingText);
                  loopManager.appendOutput(loop.loopId, thinkingText);
                }
              }
            }
            if (message.type === 'result') {
              costUsd = (message as any).total_cost_usd || 0;
            }
          }
          // Flush any remaining buffered content
          if (thinkingLineBuffer) {
            loopManager.appendOutput(loop.loopId, `[thinking] ${thinkingLineBuffer}`);
            thinkingLineBuffer = '';
          }
          if (lineBuffer) {
            loopManager.appendOutput(loop.loopId, lineBuffer);
            lineBuffer = '';
          }
        })(),
        idleMonitor.promise,
      ]);

      const durationMs = Date.now() - startTime;
      await writer?.complete(costUsd, durationMs);

      // Check for completion signal
      if (output.includes('TASK_COMPLETE')) {
        // Run per-loop review before considering task complete
        loopManager.updateReviewStatus(loop.loopId, 'in_progress');
        const otherLoopsSummary = loopManager.getOtherLoopsSummary(loop.loopId, state.tasks);

        const reviewResult = await executeLoopReview(
          state,
          loop,
          task,
          otherLoopsSummary,
          onLoopOutput ? (text) => onLoopOutput(loop.loopId, `[review] ${text}`) : undefined,
          tracer
        );

        // Add review cost to loop cost
        costUsd += reviewResult.costUsd;

        if (reviewResult.passed) {
          // Review passed - reset revision attempts and proceed
          loopManager.updateReviewStatus(loop.loopId, 'passed', reviewResult.reviewId);
          loopManager.resetRevisionAttempts(loop.loopId);

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

        // Review failed - check if we've exceeded max revision attempts
        loopManager.updateReviewStatus(loop.loopId, 'failed', reviewResult.reviewId);
        loopManager.incrementRevisionAttempts(loop.loopId);

        if (loopManager.hasExceededMaxRevisions(loop.loopId, effortConfig.maxRevisionAttempts)) {
          // Exceeded max revisions - mark loop as stuck
          loopManager.updateLoopStatus(loop.loopId, 'stuck');
          loop.stuckIndicators.lastError = `Review failed after ${effortConfig.maxRevisionAttempts} revision attempts`;
          tracer?.logError(
            `Loop ${loop.loopId} exceeded max revision attempts (${effortConfig.maxRevisionAttempts})`,
            'build'
          );
          return {
            loopId: loop.loopId,
            taskId: task.id,
            completed: false,
            costUsd,
            reviewFailed: true,
            exceededMaxRevisions: true,
          };
        }

        // Store review issues as feedback for next iteration
        // The issues will be picked up by buildPromptWithFeedback on next iteration
        for (const issue of reviewResult.issues) {
          if (!state.context.reviewIssues) {
            state.context.reviewIssues = [];
          }
          // Avoid duplicates
          const exists = state.context.reviewIssues.some(
            (i) =>
              i.taskId === issue.taskId &&
              i.file === issue.file &&
              i.description === issue.description
          );
          if (!exists) {
            state.context.reviewIssues.push(issue);
          }
        }

        tracer?.logError(
          `Loop ${loop.loopId} review failed (attempt ${loop.revisionAttempts}/${effortConfig.maxRevisionAttempts}): ${reviewResult.issues.length} issues`,
          'build'
        );

        // Don't mark as completed - loop will continue with feedback
        return {
          loopId: loop.loopId,
          taskId: task.id,
          completed: false,
          costUsd,
          reviewFailed: true,
          reviewIssues: reviewResult.issues,
        };
      }

      // Check for stuck signal
      if (output.includes('TASK_STUCK:')) {
        const stuckMatch = output.match(/TASK_STUCK:\s*(.+)/);
        errorMessage = stuckMatch?.[1] || 'Unknown reason';
        hasError = true;
      }
    } catch (e) {
      if (e instanceof IdleTimeoutError) {
        // Agent hit idle timeout - mark as stuck
        loopManager.updateLoopStatus(loop.loopId, 'stuck');
        loop.stuckIndicators.lastError = e.message;
        const durationMs = Date.now() - startTime;
        await writer?.complete(costUsd, durationMs);
        tracer?.logError(`Loop ${loop.loopId} idle timeout: ${e.message}`, 'build');
        return {
          loopId: loop.loopId,
          taskId: task.id,
          completed: false,
          costUsd,
          idleTimeout: true,
        };
      }
      hasError = true;
      errorMessage = String(e);
      // Log the error to trace for debugging
      tracer?.logError(`Loop ${loop.loopId} error: ${errorMessage}`, 'build');
    } finally {
      idleMonitor.cancel();
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

  // Check if any loop needs review (legacy interval-based review)
  const needsReview = loopManager
    .getActiveLoops()
    .some((loop) => loopManager.needsReview(loop.loopId));

  // Check if any loop hit idle timeout or exceeded max revisions
  const hadIdleTimeout = results.some((r) => 'idleTimeout' in r && r.idleTimeout);
  const hadExceededMaxRevisions = results.some(
    (r) => 'exceededMaxRevisions' in r && r.exceededMaxRevisions
  );

  // A loop is stuck if it hit idle timeout OR exceeded max revisions
  const isStuck = hadIdleTimeout || hadExceededMaxRevisions;

  return {
    completedTasks: [...state.completedTasks, ...newlyCompleted],
    activeLoops: loopManager.getAllLoops(),
    needsReview,
    stuck: isStuck,
    loopCosts,
  };
}
