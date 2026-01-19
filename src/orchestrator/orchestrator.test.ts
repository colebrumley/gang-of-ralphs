import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { CostTracking, LoopState, OrchestratorState, Phase } from '../types/index.js';
import { buildStateSnapshot, getExitCode, runOrchestrator, updateCosts } from './index.js';

// Helper to create a minimal valid state for testing
function createTestState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    runId: 'test-run',
    specPath: '/path/to/spec.md',
    effort: 'medium',
    phase: 'enumerate',
    phaseHistory: [],
    tasks: [],
    taskGraph: null,
    activeLoops: [],
    completedTasks: [],
    pendingReview: false,
    reviewType: null,
    revisionCount: 0,
    context: {
      discoveries: [],
      errors: [],
      decisions: [],
      reviewIssues: [],
    },
    costs: {
      totalCostUsd: 0,
      phaseCosts: {
        enumerate: 0,
        plan: 0,
        build: 0,
        review: 0,
        revise: 0,
        conflict: 0,
        complete: 0,
      },
      loopCosts: {},
    },
    costLimits: {
      perRunMaxUsd: 10,
      perPhaseMaxUsd: 5,
      perLoopMaxUsd: 2,
    },
    maxLoops: 4,
    maxIterations: 20,
    stateDir: '.sq',
    baseBranch: 'main',
    useWorktrees: false,
    debug: false,
    pendingConflicts: [],
    wasEmptyProject: null,
    ...overrides,
  };
}

// Helper to create a loop state for testing
function createTestLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: 'loop-1',
    taskIds: ['task-1'],
    iteration: 0,
    maxIterations: 20,
    reviewInterval: 5,
    lastReviewAt: 0,
    status: 'running',
    stuckIndicators: {
      sameErrorCount: 0,
      noProgressCount: 0,
      lastError: null,
      lastFileChangeIteration: 0,
      lastActivityAt: Date.now(),
    },
    output: [],
    worktreePath: null,
    phase: 'build',
    reviewStatus: 'pending',
    lastReviewId: null,
    revisionAttempts: 0,
    lastCheckpointReviewAt: 0,
    ...overrides,
  };
}

describe('Orchestrator', () => {
  describe('getExitCode', () => {
    test('returns 0 when phase is complete', () => {
      const state = createTestState({ phase: 'complete' });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('returns 2 when any loop is stuck', () => {
      const stuckLoop = createTestLoop({ status: 'stuck' });
      const state = createTestState({
        phase: 'build',
        activeLoops: [stuckLoop],
      });
      assert.strictEqual(getExitCode(state), 2);
    });

    test('returns 1 when there are errors but no stuck loops', () => {
      const state = createTestState({
        phase: 'build',
        context: {
          discoveries: [],
          errors: ['Some error occurred'],
          decisions: [],
          reviewIssues: [],
        },
      });
      assert.strictEqual(getExitCode(state), 1);
    });

    test('returns 0 when still running without issues', () => {
      const runningLoop = createTestLoop({ status: 'running' });
      const state = createTestState({
        phase: 'build',
        activeLoops: [runningLoop],
      });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('stuck takes priority over errors', () => {
      const stuckLoop = createTestLoop({ status: 'stuck' });
      const state = createTestState({
        phase: 'build',
        activeLoops: [stuckLoop],
        context: {
          discoveries: [],
          errors: ['Some error'],
          decisions: [],
          reviewIssues: [],
        },
      });
      // Stuck (2) takes priority over errors (1)
      assert.strictEqual(getExitCode(state), 2);
    });

    test('returns 0 for enumerate phase', () => {
      const state = createTestState({ phase: 'enumerate' });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('returns 0 for plan phase', () => {
      const state = createTestState({ phase: 'plan' });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('returns 0 for review phase', () => {
      const state = createTestState({ phase: 'review' });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('returns 0 for revise phase', () => {
      const state = createTestState({ phase: 'revise' });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('returns 0 for conflict phase', () => {
      const state = createTestState({ phase: 'conflict' });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('multiple running loops return 0', () => {
      const loop1 = createTestLoop({ loopId: 'loop-1', status: 'running' });
      const loop2 = createTestLoop({ loopId: 'loop-2', status: 'running' });
      const state = createTestState({
        phase: 'build',
        activeLoops: [loop1, loop2],
      });
      assert.strictEqual(getExitCode(state), 0);
    });

    test('one stuck loop among multiple returns 2', () => {
      const loop1 = createTestLoop({ loopId: 'loop-1', status: 'running' });
      const loop2 = createTestLoop({ loopId: 'loop-2', status: 'stuck' });
      const loop3 = createTestLoop({ loopId: 'loop-3', status: 'completed' });
      const state = createTestState({
        phase: 'build',
        activeLoops: [loop1, loop2, loop3],
      });
      assert.strictEqual(getExitCode(state), 2);
    });

    test('completed and failed loops do not affect exit code', () => {
      const loop1 = createTestLoop({ loopId: 'loop-1', status: 'completed' });
      const loop2 = createTestLoop({ loopId: 'loop-2', status: 'failed' });
      const state = createTestState({
        phase: 'build',
        activeLoops: [loop1, loop2],
      });
      // No stuck loops, no errors, still running
      assert.strictEqual(getExitCode(state), 0);
    });
  });

  describe('updateCosts', () => {
    function createTestCosts(): CostTracking {
      return {
        totalCostUsd: 0,
        phaseCosts: {
          enumerate: 0,
          plan: 0,
          build: 0,
          review: 0,
          revise: 0,
          conflict: 0,
          complete: 0,
        },
        loopCosts: {},
      };
    }

    test('adds cost to totalCostUsd', () => {
      const costs = createTestCosts();
      updateCosts(costs, 'enumerate', 0.5);
      assert.strictEqual(costs.totalCostUsd, 0.5);
    });

    test('adds cost to correct phase', () => {
      const costs = createTestCosts();
      updateCosts(costs, 'enumerate', 0.1);
      updateCosts(costs, 'plan', 0.2);
      updateCosts(costs, 'build', 0.3);

      assert.strictEqual(costs.phaseCosts.enumerate, 0.1);
      assert.strictEqual(costs.phaseCosts.plan, 0.2);
      assert.strictEqual(costs.phaseCosts.build, 0.3);
    });

    test('accumulates costs for same phase', () => {
      const costs = createTestCosts();
      updateCosts(costs, 'build', 0.5);
      updateCosts(costs, 'build', 0.3);
      updateCosts(costs, 'build', 0.2);

      assert.strictEqual(costs.phaseCosts.build, 1.0);
      assert.strictEqual(costs.totalCostUsd, 1.0);
    });

    test('adds cost to loopCosts when loopId provided', () => {
      const costs = createTestCosts();
      updateCosts(costs, 'build', 0.5, 'loop-1');

      assert.strictEqual(costs.loopCosts['loop-1'], 0.5);
      assert.strictEqual(costs.phaseCosts.build, 0.5);
      assert.strictEqual(costs.totalCostUsd, 0.5);
    });

    test('accumulates loop costs for same loop', () => {
      const costs = createTestCosts();
      updateCosts(costs, 'build', 0.3, 'loop-1');
      updateCosts(costs, 'build', 0.2, 'loop-1');

      assert.strictEqual(costs.loopCosts['loop-1'], 0.5);
    });

    test('tracks costs for multiple loops separately', () => {
      const costs = createTestCosts();
      updateCosts(costs, 'build', 0.3, 'loop-1');
      updateCosts(costs, 'build', 0.5, 'loop-2');
      updateCosts(costs, 'build', 0.1, 'loop-1');

      assert.strictEqual(costs.loopCosts['loop-1'], 0.4);
      assert.strictEqual(costs.loopCosts['loop-2'], 0.5);
      assert.strictEqual(costs.phaseCosts.build, 0.9);
      assert.strictEqual(costs.totalCostUsd, 0.9);
    });

    test('does not add to loopCosts when loopId not provided', () => {
      const costs = createTestCosts();
      updateCosts(costs, 'enumerate', 0.5);

      assert.deepStrictEqual(costs.loopCosts, {});
    });

    test('handles all phase types', () => {
      const costs = createTestCosts();
      const phases: Phase[] = [
        'enumerate',
        'plan',
        'build',
        'review',
        'revise',
        'conflict',
        'complete',
      ];

      for (const phase of phases) {
        updateCosts(costs, phase, 0.1);
      }

      assert.strictEqual(costs.totalCostUsd, 0.7);
      for (const phase of phases) {
        assert.strictEqual(costs.phaseCosts[phase], 0.1, `Phase ${phase} should have cost 0.1`);
      }
    });
  });

  describe('buildStateSnapshot', () => {
    test('captures basic state metrics', () => {
      const state = createTestState({
        phase: 'build',
        tasks: [
          {
            id: 't1',
            title: 'Task 1',
            description: '',
            status: 'completed',
            dependencies: [],
            estimatedIterations: 5,
            assignedLoopId: null,
          },
          {
            id: 't2',
            title: 'Task 2',
            description: '',
            status: 'pending',
            dependencies: [],
            estimatedIterations: 5,
            assignedLoopId: null,
          },
          {
            id: 't3',
            title: 'Task 3',
            description: '',
            status: 'failed',
            dependencies: [],
            estimatedIterations: 5,
            assignedLoopId: null,
          },
        ],
        completedTasks: ['t1'],
      });

      const snapshot = buildStateSnapshot(state);

      assert.strictEqual(snapshot.phase, 'build');
      assert.strictEqual(snapshot.tasks.total, 3);
      assert.strictEqual(snapshot.tasks.completed, 1);
      assert.strictEqual(snapshot.tasks.failed, 1);
    });

    test('captures loop status counts', () => {
      const state = createTestState({
        activeLoops: [
          createTestLoop({ loopId: 'loop-1', status: 'running' }),
          createTestLoop({ loopId: 'loop-2', status: 'running' }),
          createTestLoop({ loopId: 'loop-3', status: 'stuck' }),
          createTestLoop({ loopId: 'loop-4', status: 'completed' }),
          createTestLoop({ loopId: 'loop-5', status: 'completed' }),
          createTestLoop({ loopId: 'loop-6', status: 'completed' }),
        ],
      });

      const snapshot = buildStateSnapshot(state);

      assert.strictEqual(snapshot.loops.active, 2);
      assert.strictEqual(snapshot.loops.stuck, 1);
      assert.strictEqual(snapshot.loops.completed, 3);
    });

    test('captures context counts', () => {
      const state = createTestState({
        context: {
          discoveries: ['Found pattern A', 'Found pattern B'],
          errors: ['Error 1'],
          decisions: ['Decision 1', 'Decision 2', 'Decision 3'],
          reviewIssues: [],
        },
      });

      const snapshot = buildStateSnapshot(state);

      assert.strictEqual(snapshot.context.discoveryCount, 2);
      assert.strictEqual(snapshot.context.errorCount, 1);
      assert.strictEqual(snapshot.context.decisionCount, 3);
    });

    test('captures cost information', () => {
      const state = createTestState({
        costs: {
          totalCostUsd: 1.5,
          phaseCosts: {
            enumerate: 0.2,
            plan: 0.3,
            build: 0.8,
            review: 0.2,
            revise: 0,
            conflict: 0,
            complete: 0,
          },
          loopCosts: { 'loop-1': 0.5 },
        },
      });

      const snapshot = buildStateSnapshot(state);

      assert.strictEqual(snapshot.costs.totalUsd, 1.5);
      assert.deepStrictEqual(snapshot.costs.byPhase, state.costs.phaseCosts);
    });

    test('handles empty state', () => {
      const state = createTestState();
      const snapshot = buildStateSnapshot(state);

      assert.strictEqual(snapshot.phase, 'enumerate');
      assert.strictEqual(snapshot.tasks.total, 0);
      assert.strictEqual(snapshot.tasks.completed, 0);
      assert.strictEqual(snapshot.tasks.failed, 0);
      assert.strictEqual(snapshot.loops.active, 0);
      assert.strictEqual(snapshot.loops.stuck, 0);
      assert.strictEqual(snapshot.loops.completed, 0);
      assert.strictEqual(snapshot.context.discoveryCount, 0);
      assert.strictEqual(snapshot.context.errorCount, 0);
      assert.strictEqual(snapshot.context.decisionCount, 0);
      assert.strictEqual(snapshot.costs.totalUsd, 0);
    });
  });

  describe('runOrchestrator', () => {
    describe('cost limit checking', () => {
      test('transitions to complete when run cost limit exceeded', async () => {
        const state = createTestState({
          phase: 'enumerate',
          costs: {
            totalCostUsd: 15, // Exceeds perRunMaxUsd of 10
            phaseCosts: {
              enumerate: 0,
              plan: 0,
              build: 15,
              review: 0,
              revise: 0,
              conflict: 0,
              complete: 0,
            },
            loopCosts: {},
          },
        });

        const result = await runOrchestrator(state);

        assert.strictEqual(result.phase, 'complete');
        assert.ok(result.context.errors.length > 0, 'Should have error message');
        assert.ok(
          result.context.errors[0].includes('cost limit'),
          'Error should mention cost limit'
        );
      });

      test('adds phase history entry when cost limit exceeded', async () => {
        const state = createTestState({
          phase: 'build',
          costs: {
            totalCostUsd: 100,
            phaseCosts: {
              enumerate: 0,
              plan: 0,
              build: 100,
              review: 0,
              revise: 0,
              conflict: 0,
              complete: 0,
            },
            loopCosts: {},
          },
        });

        const result = await runOrchestrator(state);

        assert.strictEqual(result.phaseHistory.length, 1);
        assert.strictEqual(result.phaseHistory[0].phase, 'build');
        assert.strictEqual(result.phaseHistory[0].success, false);
        assert.strictEqual(result.phaseHistory[0].costUsd, 0);
      });

      test('calls onPhaseComplete callback with false when cost exceeded', async () => {
        const state = createTestState({
          phase: 'plan',
          costs: {
            totalCostUsd: 20,
            phaseCosts: {
              enumerate: 0,
              plan: 0,
              build: 20,
              review: 0,
              revise: 0,
              conflict: 0,
              complete: 0,
            },
            loopCosts: {},
          },
        });

        let callbackCalled = false;
        let callbackPhase: Phase | null = null;
        let callbackSuccess: boolean | null = null;

        await runOrchestrator(state, {
          onPhaseComplete: (phase, success) => {
            callbackCalled = true;
            callbackPhase = phase;
            callbackSuccess = success;
          },
        });

        assert.strictEqual(callbackCalled, true);
        assert.strictEqual(callbackPhase, 'complete');
        assert.strictEqual(callbackSuccess, false);
      });

      test('does not call onPhaseStart when cost limit exceeded', async () => {
        const state = createTestState({
          costs: {
            totalCostUsd: 50,
            phaseCosts: {
              enumerate: 0,
              plan: 0,
              build: 50,
              review: 0,
              revise: 0,
              conflict: 0,
              complete: 0,
            },
            loopCosts: {},
          },
        });

        let startCalled = false;

        await runOrchestrator(state, {
          onPhaseStart: () => {
            startCalled = true;
          },
        });

        assert.strictEqual(startCalled, false);
      });
    });

    describe('callback invocation', () => {
      test('calls onPhaseStart before phase execution', async () => {
        const state = createTestState({
          phase: 'complete', // Use complete phase to avoid actual execution
        });

        let startPhase: Phase | null = null;

        await runOrchestrator(state, {
          onPhaseStart: (phase) => {
            startPhase = phase;
          },
        });

        assert.strictEqual(startPhase, 'complete');
      });

      test('calls onPhaseComplete after phase execution', async () => {
        const state = createTestState({
          phase: 'complete',
        });

        let completePhase: Phase | null = null;
        let completeSuccess: boolean | null = null;

        await runOrchestrator(state, {
          onPhaseComplete: (phase, success) => {
            completePhase = phase;
            completeSuccess = success;
          },
        });

        assert.strictEqual(completePhase, 'complete');
        assert.strictEqual(completeSuccess, true);
      });
    });

    describe('complete phase', () => {
      test('does nothing when phase is complete', async () => {
        const state = createTestState({
          phase: 'complete',
          tasks: [
            {
              id: 't1',
              title: 'Task',
              description: '',
              status: 'completed',
              dependencies: [],
              estimatedIterations: 5,
              assignedLoopId: null,
            },
          ],
          completedTasks: ['t1'],
        });

        const result = await runOrchestrator(state);

        // State should be unchanged
        assert.strictEqual(result.phase, 'complete');
        assert.strictEqual(result.tasks.length, 1);
        assert.strictEqual(result.completedTasks.length, 1);
      });

      test('does not add phase history entry for complete phase', async () => {
        const state = createTestState({
          phase: 'complete',
          phaseHistory: [],
        });

        const result = await runOrchestrator(state);

        assert.strictEqual(result.phaseHistory.length, 0);
      });
    });

    describe('error handling', () => {
      test('conflict phase throws when no pending conflicts', async () => {
        const state = createTestState({
          phase: 'conflict',
          pendingConflicts: [],
        });

        const result = await runOrchestrator(state);

        // Error should be caught and added to context
        assert.ok(result.context.errors.length > 0);
        assert.ok(result.context.errors[0].includes('pending conflicts'));
      });

      test('conflict phase throws when task not found', async () => {
        const state = createTestState({
          phase: 'conflict',
          pendingConflicts: [
            { loopId: 'loop-1', taskId: 'nonexistent-task', conflictFiles: ['file.ts'] },
          ],
          tasks: [],
        });

        const result = await runOrchestrator(state);

        assert.ok(result.context.errors.length > 0);
        assert.ok(result.context.errors[0].includes('Task nonexistent-task not found'));
      });

      test('calls onPhaseComplete with false on error', async () => {
        const state = createTestState({
          phase: 'conflict',
          pendingConflicts: [],
        });

        let callbackSuccess: boolean | null = null;

        await runOrchestrator(state, {
          onPhaseComplete: (_phase, success) => {
            callbackSuccess = success;
          },
        });

        assert.strictEqual(callbackSuccess, false);
      });
    });
  });
});
