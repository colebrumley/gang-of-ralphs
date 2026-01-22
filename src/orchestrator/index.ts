import { join } from 'node:path';
import { getEffortConfig } from '../config/effort.js';
import { checkRunCostLimit, formatCostExceededError } from '../costs/index.js';
import type { DebugTracer, StateSnapshotEvent } from '../debug/index.js';
import { LoopManager } from '../loops/manager.js';
import type { CostTracking, LoopState, OrchestratorState, Phase } from '../types/index.js';
import { WorktreeManager } from '../worktrees/manager.js';
import { executeAnalyze } from './phases/analyze.js';
import { executeBuildIteration, getNextParallelGroup } from './phases/build.js';
import { resolveConflict } from './phases/conflict.js';
import { executeEnumerate } from './phases/enumerate.js';
import { executePlan } from './phases/plan.js';
import { executeReview } from './phases/review.js';
import { executeRevise } from './phases/revise.js';

/**
 * Update cost tracking state with new costs from a phase or loop execution.
 * Exported for testing.
 */
export function updateCosts(
  costs: CostTracking,
  phase: Phase,
  costUsd: number,
  loopId?: string
): void {
  costs.totalCostUsd += costUsd;
  costs.phaseCosts[phase] = (costs.phaseCosts[phase] || 0) + costUsd;
  if (loopId) {
    costs.loopCosts[loopId] = (costs.loopCosts[loopId] || 0) + costUsd;
  }
}

/**
 * Build a state snapshot for debug tracing.
 * Exported for testing.
 */
export function buildStateSnapshot(state: OrchestratorState): StateSnapshotEvent['state'] {
  return {
    phase: state.phase,
    tasks: {
      total: state.tasks.length,
      completed: state.completedTasks.length,
      failed: state.tasks.filter((t) => t.status === 'failed').length,
    },
    loops: {
      active: state.activeLoops.filter((l) => l.status === 'running').length,
      stuck: state.activeLoops.filter((l) => l.status === 'stuck').length,
      completed: state.activeLoops.filter((l) => l.status === 'completed').length,
    },
    context: {
      discoveryCount: state.context.discoveries.length,
      errorCount: state.context.errors.length,
      decisionCount: state.context.decisions.length,
    },
    costs: {
      totalUsd: state.costs.totalCostUsd,
      byPhase: state.costs.phaseCosts,
    },
  };
}

export interface OrchestratorCallbacks {
  onPhaseStart?: (phase: Phase) => void;
  onPhaseComplete?: (phase: Phase, success: boolean) => void;
  onOutput?: (text: string) => void;
  onLoopCreated?: (loop: LoopState) => void;
  onLoopOutput?: (loopId: string, text: string) => void;
  onLoopStateChange?: (loop: LoopState) => void;
  tracer?: DebugTracer;
}

export async function runOrchestrator(
  state: OrchestratorState,
  callbacks: OrchestratorCallbacks = {}
): Promise<OrchestratorState> {
  const effortConfig = getEffortConfig(state.effort);

  // Check run cost limit before executing any phase
  const runCostCheck = checkRunCostLimit(state.costs, state.costLimits);
  if (runCostCheck.exceeded) {
    const errorMsg = formatCostExceededError(runCostCheck);
    state.context.errors.push(errorMsg);
    state.phaseHistory.push({
      phase: state.phase,
      success: false,
      timestamp: new Date().toISOString(),
      summary: errorMsg,
      costUsd: 0,
    });
    state.phase = 'complete';
    callbacks.onPhaseComplete?.(state.phase, false);
    return state;
  }

  callbacks.onPhaseStart?.(state.phase);
  callbacks.tracer?.logPhaseStart(state.phase, {
    tasks: state.tasks.length,
    completedTasks: state.completedTasks.length,
    activeLoops: state.activeLoops.length,
    revisionCount: state.revisionCount,
  });

  try {
    switch (state.phase) {
      case 'analyze': {
        const result = await executeAnalyze(state, callbacks.onOutput, callbacks.tracer);
        state.codebaseAnalysis = result.analysis;
        state.wasEmptyProject = result.wasEmptyProject;
        updateCosts(state.costs, 'analyze', result.costUsd);
        state.phaseHistory.push({
          phase: 'analyze',
          success: true,
          timestamp: new Date().toISOString(),
          summary: result.wasEmptyProject
            ? 'Empty project detected'
            : `Analyzed codebase: ${result.analysis.projectType}`,
          costUsd: result.costUsd,
        });

        // Check if we need to review
        if (effortConfig.reviewAfterAnalyze) {
          callbacks.tracer?.logDecision(
            'review_trigger',
            { phase: 'analyze', effortLevel: state.effort },
            'review_scheduled',
            'Effort config requires review after analyze'
          );
          state.pendingReview = true;
          state.reviewType = 'analyze';
          state.phase = 'review';
        } else {
          state.phase = 'enumerate';
        }
        break;
      }

      case 'enumerate': {
        const result = await executeEnumerate(state, callbacks.onOutput, callbacks.tracer);
        state.tasks = result.tasks;
        updateCosts(state.costs, 'enumerate', result.costUsd);
        state.phaseHistory.push({
          phase: 'enumerate',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Enumerated ${result.tasks.length} tasks`,
          costUsd: result.costUsd,
        });

        // Check if we need to review
        if (effortConfig.reviewAfterEnumerate) {
          callbacks.tracer?.logDecision(
            'review_trigger',
            { phase: 'enumerate', effortLevel: state.effort },
            'review_scheduled',
            'Effort config requires review after enumerate'
          );
          state.pendingReview = true;
          state.reviewType = 'enumerate';
          state.phase = 'review';
        } else {
          state.phase = 'plan';
        }
        break;
      }

      case 'plan': {
        const result = await executePlan(state, callbacks.onOutput, callbacks.tracer);
        state.taskGraph = result.taskGraph;
        updateCosts(state.costs, 'plan', result.costUsd);
        state.phaseHistory.push({
          phase: 'plan',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Created plan with ${result.taskGraph.parallelGroups.length} parallel groups`,
          costUsd: result.costUsd,
        });

        if (effortConfig.reviewAfterPlan) {
          callbacks.tracer?.logDecision(
            'review_trigger',
            { phase: 'plan', effortLevel: state.effort },
            'review_scheduled',
            'Effort config requires review after plan'
          );
          state.pendingReview = true;
          state.reviewType = 'plan';
          state.phase = 'review';
        } else {
          state.phase = 'build';
        }
        break;
      }

      case 'build': {
        // Create WorktreeManager if worktrees are enabled
        const worktreeManager =
          state.useWorktrees && state.baseBranch
            ? new WorktreeManager({
                repoDir: process.cwd(),
                worktreeBaseDir: join(state.stateDir, 'worktrees'),
                baseBranch: state.baseBranch,
                runId: state.runId,
              })
            : undefined;

        const loopManager = new LoopManager(
          {
            maxLoops: state.maxLoops,
            maxIterations: state.maxIterations,
            reviewInterval: effortConfig.reviewInterval,
          },
          worktreeManager,
          callbacks.tracer
        );

        // Restore active loops from state
        for (const loop of state.activeLoops) {
          loopManager.restoreLoop(loop);
        }

        const result = await executeBuildIteration(
          state,
          loopManager,
          callbacks.onLoopCreated,
          callbacks.onLoopOutput,
          callbacks.onLoopStateChange,
          callbacks.tracer
        );

        state.completedTasks = result.completedTasks;
        state.activeLoops = result.activeLoops;

        // Track costs from each loop in this iteration
        for (const [loopId, costUsd] of Object.entries(result.loopCosts)) {
          updateCosts(state.costs, 'build', costUsd, loopId);
        }

        if (result.pendingConflicts.length > 0) {
          // Merge conflicts detected - add to pending and transition to conflict phase
          state.pendingConflicts.push(...result.pendingConflicts);
          state.phase = 'conflict';
        } else if (result.stuck) {
          callbacks.tracer?.logDecision(
            'review_trigger',
            { phase: 'build', reason: 'stuck' },
            'revise_scheduled',
            'Loop stuck, transitioning to revise phase'
          );
          state.phase = 'revise';
        } else if (!getNextParallelGroup(state.taskGraph!, state.completedTasks)) {
          // All tasks complete
          callbacks.tracer?.logDecision(
            'review_trigger',
            { phase: 'build', reason: 'all_complete' },
            'review_scheduled',
            'All tasks complete, scheduling final review'
          );
          state.phase = 'review';
          state.reviewType = 'build';
          state.pendingReview = true;
        }
        // Otherwise stay in build phase for next iteration
        break;
      }

      case 'review': {
        const result = await executeReview(
          state,
          state.reviewType,
          effortConfig.reviewDepth,
          callbacks.onOutput,
          callbacks.tracer
        );
        updateCosts(state.costs, 'review', result.costUsd);

        state.phaseHistory.push({
          phase: 'review',
          success: result.passed,
          timestamp: new Date().toISOString(),
          summary: result.passed
            ? 'Review passed'
            : `Review failed: ${result.issues.map((i) => i.description).join(', ')}`,
          costUsd: result.costUsd,
        });

        state.pendingReview = false;

        if (result.passed) {
          // Clear any previous review issues on success
          state.context.reviewIssues = [];

          // Determine next phase based on what we reviewed
          switch (state.reviewType) {
            case 'analyze':
              state.phase = 'enumerate';
              break;
            case 'enumerate':
              state.phase = 'plan';
              break;
            case 'plan':
              state.phase = 'build';
              break;
            case 'build':
              // Check if all tasks complete
              if (state.completedTasks.length === state.tasks.length) {
                state.phase = 'complete';
              } else {
                state.phase = 'build';
              }
              break;
          }
        } else {
          state.phase = 'revise';
          // Store structured issues for feedback injection in build retry
          state.context.reviewIssues = result.issues;
        }
        state.reviewType = null;
        break;
      }

      case 'revise': {
        // Check revision limit to prevent infinite review loops
        if (state.revisionCount >= effortConfig.maxRevisions) {
          const errorMsg = `Exceeded max revisions (${effortConfig.maxRevisions}). Review loop may be stuck.`;
          state.context.errors.push(errorMsg);
          state.phaseHistory.push({
            phase: 'revise',
            success: false,
            timestamp: new Date().toISOString(),
            summary: errorMsg,
            costUsd: 0,
          });
          state.phase = 'complete';
          callbacks.onPhaseComplete?.(state.phase, false);
          return state;
        }

        // Run the revise agent to analyze issues and create fix plan
        const reviseResult = await executeRevise(state, callbacks.onOutput, callbacks.tracer);
        updateCosts(state.costs, 'revise', reviseResult.costUsd);

        state.revisionCount++;

        // Store the fix plan in context for the build phase
        if (reviseResult.success && reviseResult.additionalContext) {
          state.context.discoveries.push(`Revision plan: ${reviseResult.additionalContext}`);
        }
        if (reviseResult.analysis) {
          state.context.discoveries.push(`Revision analysis: ${reviseResult.analysis}`);
        }

        if (reviseResult.success) {
          // Go back to build phase with context about what to fix
          state.phase = 'build';
          state.phaseHistory.push({
            phase: 'revise',
            success: true,
            timestamp: new Date().toISOString(),
            summary: `Revision ${state.revisionCount} - analyzed ${state.context.reviewIssues.length} issues, returning to build`,
            costUsd: reviseResult.costUsd,
          });
        } else {
          // Revise failed - cannot provide proper fix guidance to build phase
          const errorMsg = `Revision ${state.revisionCount} failed - unable to generate fix plan`;
          state.context.errors.push(errorMsg);
          state.phase = 'complete';
          state.phaseHistory.push({
            phase: 'revise',
            success: false,
            timestamp: new Date().toISOString(),
            summary: errorMsg,
            costUsd: reviseResult.costUsd,
          });
          callbacks.onPhaseComplete?.(state.phase, false);
          return state;
        }
        break;
      }

      case 'conflict': {
        if (state.pendingConflicts.length === 0) {
          throw new Error('Conflict phase entered without pending conflicts');
        }

        // Process conflicts one at a time (first in the queue)
        const conflict = state.pendingConflicts[0];
        const { loopId, taskId, conflictFiles } = conflict;
        const task = state.tasks.find((t) => t.id === taskId);

        if (!task) {
          throw new Error(`Task ${taskId} not found for conflict resolution`);
        }

        // Find the loop to get worktree path and for status updates
        const loop = state.activeLoops.find((l) => l.loopId === loopId);

        // Use main repo directory (not stateDir) for conflict resolution
        const repoDir = process.cwd();

        const result = await resolveConflict(
          task,
          conflictFiles,
          repoDir,
          state.runId,
          state.stateDir,
          state.effort,
          callbacks.onOutput,
          callbacks.tracer
        );
        updateCosts(state.costs, 'conflict', result.costUsd, loopId);

        state.phaseHistory.push({
          phase: 'conflict',
          success: result.resolved,
          timestamp: new Date().toISOString(),
          summary: result.resolved
            ? `Resolved merge conflict in ${conflictFiles.length} file(s) for loop ${loopId}`
            : `Failed to resolve conflict for loop ${loopId}: ${result.error}`,
          costUsd: result.costUsd,
        });

        // Remove the processed conflict from the queue
        state.pendingConflicts.shift();

        if (result.resolved) {
          // Mark the loop as completed and remove from activeLoops
          // This prevents the completed loop from being restored in the next BUILD phase
          // and potentially triggering incorrect stuck detection
          if (loop) {
            loop.status = 'completed';
            // Remove the completed loop from activeLoops to keep state clean
            state.activeLoops = state.activeLoops.filter((l) => l.loopId !== loopId);
          }

          // Add the task to completedTasks if not already there
          if (!state.completedTasks.includes(taskId)) {
            state.completedTasks.push(taskId);
          }

          // Also update the task status in state.tasks for consistency
          const taskToUpdate = state.tasks.find((t) => t.id === taskId);
          if (taskToUpdate) {
            taskToUpdate.status = 'completed';
          }

          // Clean up the worktree now that merge is complete
          if (state.useWorktrees && state.baseBranch && loop?.worktreePath) {
            const worktreeManager = new WorktreeManager({
              repoDir,
              worktreeBaseDir: join(state.stateDir, 'worktrees'),
              baseBranch: state.baseBranch,
              runId: state.runId,
            });
            try {
              await worktreeManager.cleanup(loopId);
            } catch (e) {
              // Log but don't fail - worktree cleanup is best-effort
              callbacks.tracer?.logError(
                `Failed to cleanup worktree for loop ${loopId}: ${e}`,
                'conflict'
              );
            }
          }
        } else {
          // Mark the loop as failed and remove from activeLoops
          if (loop) {
            loop.status = 'failed';
            state.activeLoops = state.activeLoops.filter((l) => l.loopId !== loopId);
          }

          // Mark the task as failed
          const taskToUpdate = state.tasks.find((t) => t.id === taskId);
          if (taskToUpdate) {
            taskToUpdate.status = 'failed';
          }

          state.context.errors.push(
            `Conflict resolution failed for loop ${loopId}: ${result.error}`
          );
        }

        // If more conflicts remain, stay in conflict phase; otherwise return to build
        if (state.pendingConflicts.length > 0) {
          // Stay in conflict phase to process remaining conflicts
          state.phase = 'conflict';
        } else {
          state.phase = 'build';
        }
        break;
      }

      case 'complete': {
        // Nothing to do - orchestrator will exit
        break;
      }
    }

    // Log phase completion
    const phaseEntry = state.phaseHistory[state.phaseHistory.length - 1];
    if (phaseEntry) {
      callbacks.tracer?.logPhaseComplete(
        phaseEntry.phase,
        phaseEntry.success,
        phaseEntry.costUsd,
        phaseEntry.summary
      );
    }

    // Log state snapshot on phase transition
    const previousPhase = phaseEntry?.phase;
    if (previousPhase && previousPhase !== state.phase) {
      callbacks.tracer?.logStateSnapshot('phase_transition', buildStateSnapshot(state));
    }

    // Log run complete snapshot
    if (state.phase === 'complete') {
      callbacks.tracer?.logStateSnapshot('run_complete', buildStateSnapshot(state));
    }

    callbacks.onPhaseComplete?.(state.phase, true);
  } catch (error) {
    const errorStr = String(error);
    state.context.errors.push(errorStr);
    callbacks.tracer?.logError(errorStr, state.phase);
    callbacks.tracer?.logStateSnapshot('error', buildStateSnapshot(state));
    callbacks.onPhaseComplete?.(state.phase, false);
  }

  return state;
}

export function getExitCode(state: OrchestratorState): number {
  if (state.phase === 'complete') return 0;
  if (state.activeLoops.some((l) => l.status === 'stuck')) return 2;
  if (state.context.errors.length > 0) return 1;
  return 0; // Still running, will be restarted by outer loop
}
