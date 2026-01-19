import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { LoopState } from '../types/index.js';
import { StuckReason, detectStuck } from './stuck-detection.js';

describe('Stuck Detection', () => {
  const baseLoop: LoopState = {
    loopId: 'test',
    taskIds: ['t1'],
    iteration: 10,
    maxIterations: 20,
    reviewInterval: 5,
    lastReviewAt: 5,
    status: 'running',
    stuckIndicators: {
      sameErrorCount: 0,
      noProgressCount: 0,
      lastError: null,
      lastFileChangeIteration: 10,
      lastActivityAt: Date.now(),
    },
    output: [],
    worktreePath: null,
    phase: 'build',
    reviewStatus: 'pending',
    lastReviewId: null,
    revisionAttempts: 0,
    lastCheckpointReviewAt: 0,
  };

  test('returns null when not stuck', () => {
    const result = detectStuck(baseLoop, { stuckThreshold: 3 });
    assert.strictEqual(result, null);
  });

  test('detects same error repeated', () => {
    const loop = {
      ...baseLoop,
      stuckIndicators: {
        ...baseLoop.stuckIndicators,
        sameErrorCount: 4,
        lastError: 'TypeError: cannot read property',
      },
    };

    const result = detectStuck(loop, { stuckThreshold: 3 });

    assert.strictEqual(result?.reason, StuckReason.REPEATED_ERROR);
  });

  test('detects no progress', () => {
    const loop = {
      ...baseLoop,
      iteration: 15,
      stuckIndicators: {
        ...baseLoop.stuckIndicators,
        noProgressCount: 5,
        lastFileChangeIteration: 10,
      },
    };

    const result = detectStuck(loop, { stuckThreshold: 3 });

    assert.strictEqual(result?.reason, StuckReason.NO_PROGRESS);
  });

  test('detects max iterations exceeded', () => {
    const loop = {
      ...baseLoop,
      iteration: 21,
    };

    const result = detectStuck(loop, { stuckThreshold: 3 });

    assert.strictEqual(result?.reason, StuckReason.MAX_ITERATIONS);
  });
});
