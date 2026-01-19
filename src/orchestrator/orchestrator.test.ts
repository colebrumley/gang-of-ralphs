import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { LoopState, OrchestratorState } from '../types/index.js';
import { getExitCode } from './index.js';

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
    pendingConflict: null,
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
});
