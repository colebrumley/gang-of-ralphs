import { join } from 'node:path';
import { getEffortConfig } from '../config/effort.js';
import { checkRunCostLimit, formatCostExceededError } from '../costs/index.js';
import { LoopManager } from '../loops/manager.js';
import type { CostTracking, OrchestratorState, Phase } from '../types/index.js';
import { WorktreeManager } from '../worktrees/manager.js';
import { executeBuildIteration, getNextParallelGroup } from './phases/build.js';
import { resolveConflict } from './phases/conflict.js';
import { executeEnumerate } from './phases/enumerate.js';
import { executePlan } from './phases/plan.js';
import { executeReview } from './phases/review.js';
import { executeRevise } from './phases/revise.js';

/**
 * Update cost tracking state with new costs from a phase or loop execution.
 */
function updateCosts(costs: CostTracking, phase: Phase, costUsd: number, loopId?: string): void {
  costs.totalCostUsd += costUsd;
  costs.phaseCosts[phase] = (costs.phaseCosts[phase] || 0) + costUsd;
  if (loopId) {
    costs.loopCosts[loopId] = (costs.loopCosts[loopId] || 0) + costUsd;
  }
}

export interface OrchestratorCallbacks {
  onPhaseStart?: (phase: Phase) => void;
  onPhaseComplete?: (phase: Phase, success: boolean) => void;
  onOutput?: (text: string) => void;
  onLoopOutput?: (loopId: string, text: string) => void;
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

  try {
    switch (state.phase) {
      case 'enumerate': {
        const result = await executeEnumerate(state, callbacks.onOutput);
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
          state.pendingReview = true;
          state.reviewType = 'enumerate';
          state.phase = 'review';
        } else {
          state.phase = 'plan';
        }
        break;
      }

      case 'plan': {
        const result = await executePlan(state, callbacks.onOutput);
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
          worktreeManager
        );

        // Restore active loops from state
        for (const loop of state.activeLoops) {
          loopManager.restoreLoop(loop);
        }

        const result = await executeBuildIteration(state, loopManager, callbacks.onLoopOutput);

        state.completedTasks = result.completedTasks;
        state.activeLoops = result.activeLoops;

        // Track costs from each loop in this iteration
        for (const [loopId, costUsd] of Object.entries(result.loopCosts)) {
          updateCosts(state.costs, 'build', costUsd, loopId);
        }

        if (result.pendingConflict) {
          // Merge conflict detected - transition to conflict phase
          state.pendingConflict = result.pendingConflict;
          state.phase = 'conflict';
        } else if (result.stuck) {
          state.phase = 'revise';
        } else if (result.needsReview) {
          state.pendingReview = true;
          state.reviewType = 'build';
          state.phase = 'review';
        } else if (!getNextParallelGroup(state.taskGraph!, state.completedTasks)) {
          // All tasks complete
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
          callbacks.onOutput
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
        const reviseResult = await executeRevise(state, callbacks.onOutput);
        updateCosts(state.costs, 'revise', reviseResult.costUsd);

        state.revisionCount++;

        // Store the fix plan in context for the build phase
        if (reviseResult.success && reviseResult.additionalContext) {
          state.context.discoveries.push(`Revision plan: ${reviseResult.additionalContext}`);
        }
        if (reviseResult.analysis) {
          state.context.discoveries.push(`Revision analysis: ${reviseResult.analysis}`);
        }

        // Go back to build phase with context about what to fix
        state.phase = 'build';
        state.phaseHistory.push({
          phase: 'revise',
          success: reviseResult.success,
          timestamp: new Date().toISOString(),
          summary: reviseResult.success
            ? `Revision ${state.revisionCount} - analyzed ${state.context.reviewIssues.length} issues, returning to build`
            : `Revision ${state.revisionCount} - analysis incomplete, returning to build`,
          costUsd: reviseResult.costUsd,
        });
        break;
      }

      case 'conflict': {
        if (!state.pendingConflict) {
          throw new Error('Conflict phase entered without pendingConflict state');
        }

        const { loopId, taskId, conflictFiles } = state.pendingConflict;
        const task = state.tasks.find((t) => t.id === taskId);

        if (!task) {
          throw new Error(`Task ${taskId} not found for conflict resolution`);
        }

        const result = await resolveConflict(
          task,
          conflictFiles,
          state.stateDir,
          state.runId,
          state.stateDir,
          callbacks.onOutput
        );
        updateCosts(state.costs, 'conflict', result.costUsd, loopId);

        state.phaseHistory.push({
          phase: 'conflict',
          success: result.resolved,
          timestamp: new Date().toISOString(),
          summary: result.resolved
            ? `Resolved merge conflict in ${conflictFiles.length} file(s)`
            : `Failed to resolve conflict: ${result.error}`,
          costUsd: result.costUsd,
        });

        if (result.resolved) {
          state.pendingConflict = null;
          state.phase = 'build';
        } else {
          // Mark the loop as failed
          const loop = state.activeLoops.find((l) => l.loopId === loopId);
          if (loop) {
            loop.status = 'failed';
          }
          state.context.errors.push(`Conflict resolution failed: ${result.error}`);
          state.pendingConflict = null;
          state.phase = 'build';
        }
        break;
      }

      case 'complete': {
        // Nothing to do - orchestrator will exit
        break;
      }
    }

    callbacks.onPhaseComplete?.(state.phase, true);
  } catch (error) {
    state.context.errors.push(String(error));
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
