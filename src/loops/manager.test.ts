import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LoopManager } from './manager.js';
import { WorktreeManager } from '../worktrees/manager.js';
import type { Task } from '../types/index.js';

describe('Loop Manager', () => {
  test('createLoop initializes loop with correct state', async () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });
    const tasks: Task[] = [
      { id: 't1', title: 'Task 1', description: '', status: 'pending', dependencies: [], estimatedIterations: 5, assignedLoopId: null }
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
});

describe('LoopManager with worktrees', () => {
  let testDir: string;
  let repoDir: string;
  let loopManager: LoopManager;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'c2-loop-wt-test-'));
    repoDir = join(testDir, 'repo');
    execSync(`mkdir -p ${repoDir} && cd ${repoDir} && git init && git commit --allow-empty -m "init"`, { stdio: 'pipe' });

    worktreeManager = new WorktreeManager({
      repoDir,
      worktreeBaseDir: join(repoDir, '.c2', 'worktrees'),
      baseBranch: 'main',
      runId: 'test-run',
    });

    loopManager = new LoopManager({
      maxLoops: 4,
      maxIterations: 20,
      reviewInterval: 5,
    }, worktreeManager);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('creates worktree when creating loop', async () => {
    const tasks: Task[] = [
      { id: 'task-1', title: 'Test', description: '', status: 'pending', dependencies: [], estimatedIterations: 10, assignedLoopId: null }
    ];
    const loop = await loopManager.createLoop(['task-1'], tasks);

    assert.ok(loop.worktreePath);
    assert.ok(loop.worktreePath.includes(loop.loopId));
  });
});
