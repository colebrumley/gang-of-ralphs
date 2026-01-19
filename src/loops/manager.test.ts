import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Task } from '../types/index.js';
import { WorktreeManager } from '../worktrees/manager.js';
import { LoopManager } from './manager.js';

describe('Loop Manager', () => {
  test('createLoop initializes loop with correct state', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });
    const tasks: Task[] = [
      {
        id: 't1',
        title: 'Task 1',
        description: '',
        status: 'pending',
        dependencies: [],
        estimatedIterations: 5,
        assignedLoopId: null,
      },
    ];

    const loop = await manager.createLoop(['t1'], tasks);

    assert.ok(loop.loopId);
    assert.deepStrictEqual(loop.taskIds, ['t1']);
    assert.strictEqual(loop.status, 'pending');
    assert.strictEqual(loop.iteration, 0);
  });

  test('canSpawnMore respects maxLoops', async () => {
    const manager = new LoopManager({ maxLoops: 2, maxIterations: 20, reviewInterval: 5 });

    assert.strictEqual(manager.canSpawnMore(), true);
    await manager.createLoop(['t1'], []);
    assert.strictEqual(manager.canSpawnMore(), true);
    await manager.createLoop(['t2'], []);
    assert.strictEqual(manager.canSpawnMore(), false);
  });

  test('getActiveLoops returns only running loops', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });

    const loop1 = await manager.createLoop(['t1'], []);
    const loop2 = await manager.createLoop(['t2'], []);

    manager.updateLoopStatus(loop1.loopId, 'running');
    manager.updateLoopStatus(loop2.loopId, 'completed');

    const active = manager.getActiveLoops();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].loopId, loop1.loopId);
  });

  test('restoreLoop restores loop from persisted state', () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });

    const persistedLoop = {
      loopId: 'restored-loop-123',
      taskIds: ['t1', 't2'],
      iteration: 5,
      maxIterations: 20,
      reviewInterval: 5,
      lastReviewAt: 3,
      status: 'running' as const,
      stuckIndicators: {
        sameErrorCount: 1,
        noProgressCount: 0,
        lastError: 'some error',
        lastFileChangeIteration: 4,
        lastActivityAt: Date.now(),
      },
      output: ['line1', 'line2'],
      worktreePath: '/path/to/worktree',
      phase: 'build',
      reviewStatus: 'pending' as const,
      lastReviewId: null,
      revisionAttempts: 0,
      lastCheckpointReviewAt: 0,
    };

    manager.restoreLoop(persistedLoop);

    const restored = manager.getLoop('restored-loop-123');
    assert.ok(restored);
    assert.strictEqual(restored.loopId, 'restored-loop-123');
    assert.deepStrictEqual(restored.taskIds, ['t1', 't2']);
    assert.strictEqual(restored.iteration, 5);
    assert.strictEqual(restored.status, 'running');
    assert.strictEqual(restored.stuckIndicators.sameErrorCount, 1);
    assert.strictEqual(restored.worktreePath, '/path/to/worktree');

    // Verify it's counted in active loops
    const active = manager.getActiveLoops();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].loopId, 'restored-loop-123');
  });
});

describe('Checkpoint Review Methods', () => {
  test('needsCheckpointReview returns false when interval is null', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });
    const loop = await manager.createLoop(['t1'], []);
    manager.updateLoopStatus(loop.loopId, 'running');
    for (let i = 0; i < 10; i++) {
      manager.incrementIteration(loop.loopId);
    }

    // With null interval, should never need checkpoint review
    assert.strictEqual(manager.needsCheckpointReview(null), false);
  });

  test('needsCheckpointReview returns true when iterations exceed interval', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });
    const loop = await manager.createLoop(['t1'], []);
    manager.updateLoopStatus(loop.loopId, 'running');

    // At iteration 0, lastCheckpointReviewAt = 0, interval = 3: 0 - 0 = 0, not >= 3
    assert.strictEqual(manager.needsCheckpointReview(3), false);

    manager.incrementIteration(loop.loopId); // iteration 1
    manager.incrementIteration(loop.loopId); // iteration 2
    assert.strictEqual(manager.needsCheckpointReview(3), false);

    manager.incrementIteration(loop.loopId); // iteration 3
    // Now: 3 - 0 >= 3, should need review
    assert.strictEqual(manager.needsCheckpointReview(3), true);
  });

  test('markCheckpointReviewed resets the checkpoint counter', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });
    const loop = await manager.createLoop(['t1'], []);
    manager.updateLoopStatus(loop.loopId, 'running');

    // Reach iteration 3
    for (let i = 0; i < 3; i++) {
      manager.incrementIteration(loop.loopId);
    }
    assert.strictEqual(manager.needsCheckpointReview(3), true);

    // Mark as checkpoint reviewed
    manager.markCheckpointReviewed(loop.loopId);

    // Should no longer need review
    assert.strictEqual(manager.needsCheckpointReview(3), false);

    // Reach 3 more iterations
    for (let i = 0; i < 3; i++) {
      manager.incrementIteration(loop.loopId);
    }
    // Now at iteration 6, lastCheckpointReviewAt = 3: 6 - 3 >= 3
    assert.strictEqual(manager.needsCheckpointReview(3), true);
  });

  test('getLoopsNeedingCheckpointReview returns correct loops', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });

    const loop1 = await manager.createLoop(['t1'], []);
    const loop2 = await manager.createLoop(['t2'], []);
    manager.updateLoopStatus(loop1.loopId, 'running');
    manager.updateLoopStatus(loop2.loopId, 'running');

    // Advance loop1 to iteration 5
    for (let i = 0; i < 5; i++) {
      manager.incrementIteration(loop1.loopId);
    }
    // Advance loop2 to iteration 2
    for (let i = 0; i < 2; i++) {
      manager.incrementIteration(loop2.loopId);
    }

    const needingReview = manager.getLoopsNeedingCheckpointReview(3);

    // Only loop1 should need checkpoint review (5 >= 3, but 2 < 3)
    assert.strictEqual(needingReview.length, 1);
    assert.strictEqual(needingReview[0].loopId, loop1.loopId);
  });

  test('getLoopsNeedingCheckpointReview returns empty for null interval', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });
    const loop = await manager.createLoop(['t1'], []);
    manager.updateLoopStatus(loop.loopId, 'running');
    for (let i = 0; i < 10; i++) {
      manager.incrementIteration(loop.loopId);
    }

    const needingReview = manager.getLoopsNeedingCheckpointReview(null);
    assert.strictEqual(needingReview.length, 0);
  });
});

describe('LoopManager with worktrees', () => {
  let testDir: string;
  let repoDir: string;
  let loopManager: LoopManager;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sq-loop-wt-test-'));
    repoDir = join(testDir, 'repo');
    execSync(
      `mkdir -p ${repoDir} && cd ${repoDir} && git init && git commit --allow-empty -m "init"`,
      { stdio: 'pipe' }
    );

    worktreeManager = new WorktreeManager({
      repoDir,
      worktreeBaseDir: join(repoDir, '.sq', 'worktrees'),
      baseBranch: 'main',
      runId: 'test-run',
    });

    loopManager = new LoopManager(
      {
        maxLoops: 4,
        maxIterations: 20,
        reviewInterval: 5,
      },
      worktreeManager
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('creates worktree when creating loop', async () => {
    const tasks: Task[] = [
      {
        id: 'task-1',
        title: 'Test',
        description: '',
        status: 'pending',
        dependencies: [],
        estimatedIterations: 10,
        assignedLoopId: null,
      },
    ];
    const loop = await loopManager.createLoop(['task-1'], tasks);

    assert.ok(loop.worktreePath);
    assert.ok(loop.worktreePath.includes(loop.loopId));
  });
});
