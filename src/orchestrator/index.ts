import { join } from 'node:path';
import type { OrchestratorState, Phase } from '../types/index.js';
import { getEffortConfig } from '../config/effort.js';
import { LoopManager } from '../loops/manager.js';
import { WorktreeManager } from '../worktrees/manager.js';
import { executeEnumerate } from './phases/enumerate.js';
import { executePlan } from './phases/plan.js';
import { executeBuildIteration, getNextParallelGroup } from './phases/build.js';
import { executeReview } from './phases/review.js';

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

  callbacks.onPhaseStart?.(state.phase);

  try {
    switch (state.phase) {
      case 'enumerate': {
        const tasks = await executeEnumerate(state, callbacks.onOutput);
        state.tasks = tasks;
        state.phaseHistory.push({
          phase: 'enumerate',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Enumerated ${tasks.length} tasks`,
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
        const taskGraph = await executePlan(state, callbacks.onOutput);
        state.taskGraph = taskGraph;
        state.phaseHistory.push({
          phase: 'plan',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Created plan with ${taskGraph.parallelGroups.length} parallel groups`,
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
        const worktreeManager = state.useWorktrees && state.baseBranch
          ? new WorktreeManager({
              repoDir: process.cwd(),
              worktreeBaseDir: join(state.stateDir, 'worktrees'),
              baseBranch: state.baseBranch,
              runId: state.runId,
            })
          : undefined;

        const loopManager = new LoopManager({
          maxLoops: state.maxLoops,
          maxIterations: state.maxIterations,
          reviewInterval: effortConfig.reviewInterval,
        }, worktreeManager);

        // Restore active loops from state
        for (const loop of state.activeLoops) {
          // Re-create in manager (simplified - in real impl would restore fully)
        }

        const result = await executeBuildIteration(
          state,
          loopManager,
          callbacks.onLoopOutput
        );

        state.completedTasks = result.completedTasks;
        state.activeLoops = result.activeLoops;

        if (result.stuck) {
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

        state.phaseHistory.push({
          phase: 'review',
          success: result.passed,
          timestamp: new Date().toISOString(),
          summary: result.passed
            ? 'Review passed'
            : `Review failed: ${result.issues.map(i => i.description).join(', ')}`,
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
        state.revisionCount++;
        // Go back to build phase with context about what to fix
        state.phase = 'build';
        state.phaseHistory.push({
          phase: 'revise',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Revision ${state.revisionCount} - returning to build`,
        });
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
  if (state.activeLoops.some(l => l.status === 'stuck')) return 2;
  if (state.context.errors.length > 0) return 1;
  return 0; // Still running, will be restarted by outer loop
}
