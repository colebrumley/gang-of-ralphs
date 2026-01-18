import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeDatabase, createDatabase, getDatabase } from '../db/index.js';
import { initializeState, loadState, saveRun } from './index.js';

describe('State Management', () => {
  test('initializeState creates valid initial state', async () => {
    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: '.sq',
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false, // Disable for testing (may have uncommitted changes)
    });

    assert.strictEqual(state.phase, 'enumerate');
    assert.strictEqual(state.effort, 'medium');
    assert.ok(state.runId);
  });
});

describe('State Persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sq-test-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('saveRun persists state to database', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'high',
      stateDir: tempDir,
      maxLoops: 3,
      maxIterations: 15,
      useWorktrees: false,
    });

    saveRun(state);

    // Verify by loading
    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.runId, state.runId);
    assert.strictEqual(loaded.specPath, state.specPath);
    assert.strictEqual(loaded.effort, 'high');
    assert.strictEqual(loaded.phase, 'enumerate');
  });

  test('loadState returns null when no database exists', () => {
    const loaded = loadState(join(tempDir, 'nonexistent'));
    assert.strictEqual(loaded, null);
  });

  test('loadState returns null when database has no runs', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);
    closeDatabase();

    const loaded = loadState(tempDir);
    assert.strictEqual(loaded, null);
  });

  test('saveRun updates existing run', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Modify state and save again
    state.phase = 'plan';
    state.revisionCount = 2;
    saveRun(state);

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.runId, state.runId);
    assert.strictEqual(loaded.phase, 'plan');
    assert.strictEqual(loaded.revisionCount, 2);
  });

  test('loadState restores review issues from database', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert review issues directly into database
    const db = getDatabase();
    db.prepare(`
      INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.runId,
      'task-1',
      'src/index.ts',
      42,
      'over-engineering',
      'Too complex',
      'Simplify'
    );
    db.prepare(`
      INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(state.runId, 'task-2', 'src/utils.ts', null, 'dead-code', 'Unused', 'Remove');

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.context.reviewIssues.length, 2);

    const issue1 = loaded.context.reviewIssues.find((i) => i.taskId === 'task-1');
    assert.ok(issue1);
    assert.strictEqual(issue1.file, 'src/index.ts');
    assert.strictEqual(issue1.line, 42);
    assert.strictEqual(issue1.type, 'over-engineering');
    assert.strictEqual(issue1.description, 'Too complex');
    assert.strictEqual(issue1.suggestion, 'Simplify');

    const issue2 = loaded.context.reviewIssues.find((i) => i.taskId === 'task-2');
    assert.ok(issue2);
    assert.strictEqual(issue2.file, 'src/utils.ts');
    assert.strictEqual(issue2.line, undefined);
    assert.strictEqual(issue2.type, 'dead-code');
  });

  test('loadState restores tasks from database', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert tasks directly into database
    const db = getDatabase();
    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, status, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('task-1', state.runId, 'First Task', 'Do something', 'completed', '[]', 5);
    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, status, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('task-2', state.runId, 'Second Task', 'Do more', 'pending', '["task-1"]', 10);

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.tasks.length, 2);

    const task1 = loaded.tasks.find((t) => t.id === 'task-1');
    assert.ok(task1);
    assert.strictEqual(task1.title, 'First Task');
    assert.strictEqual(task1.status, 'completed');
    assert.deepStrictEqual(task1.dependencies, []);

    const task2 = loaded.tasks.find((t) => t.id === 'task-2');
    assert.ok(task2);
    assert.strictEqual(task2.status, 'pending');
    assert.deepStrictEqual(task2.dependencies, ['task-1']);
  });

  test('loadState restores loops from database', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert a loop directly into database
    const db = getDatabase();
    db.prepare(`
      INSERT INTO loops (id, run_id, task_ids, iteration, max_iterations, review_interval,
        last_review_at, status, same_error_count, no_progress_count, last_error, last_file_change_iteration, cost_usd, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'loop-1',
      state.runId,
      '["task-1", "task-2"]',
      5,
      20,
      5,
      0,
      'running',
      1,
      0,
      'Build failed',
      3,
      0.15,
      'build'
    );

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.activeLoops.length, 1);

    const loop = loaded.activeLoops[0];
    assert.strictEqual(loop.loopId, 'loop-1');
    assert.deepStrictEqual(loop.taskIds, ['task-1', 'task-2']);
    assert.strictEqual(loop.iteration, 5);
    assert.strictEqual(loop.status, 'running');
    assert.strictEqual(loop.stuckIndicators.sameErrorCount, 1);
    assert.strictEqual(loop.stuckIndicators.lastError, 'Build failed');
    assert.strictEqual(loop.phase, 'build');
  });

  test('loadState filters out completed and failed loops', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert loops with different statuses
    const db = getDatabase();
    const insertLoop = db.prepare(`
      INSERT INTO loops (id, run_id, task_ids, iteration, max_iterations, review_interval,
        status, same_error_count, no_progress_count, cost_usd, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLoop.run('loop-1', state.runId, '["task-1"]', 5, 20, 5, 'running', 0, 0, 0, 'build');
    insertLoop.run('loop-2', state.runId, '["task-2"]', 10, 20, 5, 'completed', 0, 0, 0.5, 'build');
    insertLoop.run('loop-3', state.runId, '["task-3"]', 3, 20, 5, 'failed', 5, 0, 0.2, 'build');
    insertLoop.run('loop-4', state.runId, '["task-4"]', 7, 20, 5, 'stuck', 3, 0, 0.1, 'build');

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    // Only running and stuck loops should be in activeLoops
    assert.strictEqual(loaded.activeLoops.length, 2);

    const loopIds = loaded.activeLoops.map((l) => l.loopId);
    assert.ok(loopIds.includes('loop-1'));
    assert.ok(loopIds.includes('loop-4'));
    assert.ok(!loopIds.includes('loop-2'));
    assert.ok(!loopIds.includes('loop-3'));
  });

  test('loadState restores context entries', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert context entries
    const db = getDatabase();
    db.prepare(`
      INSERT INTO context_entries (run_id, entry_type, content)
      VALUES (?, ?, ?)
    `).run(state.runId, 'discovery', 'Found existing auth pattern');
    db.prepare(`
      INSERT INTO context_entries (run_id, entry_type, content)
      VALUES (?, ?, ?)
    `).run(state.runId, 'error', 'Build failed: missing module');
    db.prepare(`
      INSERT INTO context_entries (run_id, entry_type, content)
      VALUES (?, ?, ?)
    `).run(state.runId, 'decision', 'Using JWT for authentication');

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.context.discoveries.length, 1);
    assert.strictEqual(loaded.context.discoveries[0], 'Found existing auth pattern');
    assert.strictEqual(loaded.context.errors.length, 1);
    assert.strictEqual(loaded.context.errors[0], 'Build failed: missing module');
    assert.strictEqual(loaded.context.decisions.length, 1);
    assert.strictEqual(loaded.context.decisions[0], 'Using JWT for authentication');
  });

  test('loadState restores phase costs', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert phase costs
    const db = getDatabase();
    db.prepare(`
      INSERT INTO phase_costs (run_id, phase, cost_usd)
      VALUES (?, ?, ?)
    `).run(state.runId, 'enumerate', 0.05);
    db.prepare(`
      INSERT INTO phase_costs (run_id, phase, cost_usd)
      VALUES (?, ?, ?)
    `).run(state.runId, 'plan', 0.1);
    db.prepare(`
      INSERT INTO phase_costs (run_id, phase, cost_usd)
      VALUES (?, ?, ?)
    `).run(state.runId, 'build', 0.5);

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.costs.phaseCosts.enumerate, 0.05);
    assert.strictEqual(loaded.costs.phaseCosts.plan, 0.1);
    assert.strictEqual(loaded.costs.phaseCosts.build, 0.5);
    assert.strictEqual(loaded.costs.phaseCosts.review, 0);
  });

  test('loadState restores phase history', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    // Add phase history entries
    state.phaseHistory.push({
      phase: 'enumerate',
      success: true,
      timestamp: new Date().toISOString(),
      summary: 'Enumerated 5 tasks',
      costUsd: 0.05,
    });
    state.phaseHistory.push({
      phase: 'plan',
      success: true,
      timestamp: new Date().toISOString(),
      summary: 'Created plan with 2 groups',
      costUsd: 0.08,
    });

    saveRun(state);
    closeDatabase();

    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.phaseHistory.length, 2);
    assert.strictEqual(loaded.phaseHistory[0].phase, 'enumerate');
    assert.strictEqual(loaded.phaseHistory[0].success, true);
    assert.strictEqual(loaded.phaseHistory[0].summary, 'Enumerated 5 tasks');
    assert.strictEqual(loaded.phaseHistory[0].costUsd, 0.05);
    assert.strictEqual(loaded.phaseHistory[1].phase, 'plan');
  });

  test('loadState restores loop costs', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert loops with costs
    const db = getDatabase();
    db.prepare(`
      INSERT INTO loops (id, run_id, task_ids, iteration, max_iterations, review_interval,
        status, same_error_count, no_progress_count, cost_usd, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('loop-1', state.runId, '["task-1"]', 5, 20, 5, 'running', 0, 0, 0.25, 'build');
    db.prepare(`
      INSERT INTO loops (id, run_id, task_ids, iteration, max_iterations, review_interval,
        status, same_error_count, no_progress_count, cost_usd, phase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('loop-2', state.runId, '["task-2"]', 3, 20, 5, 'completed', 0, 0, 0.15, 'build');

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.costs.loopCosts['loop-1'], 0.25);
    assert.strictEqual(loaded.costs.loopCosts['loop-2'], 0.15);
  });

  test('saveRun persists loops', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    // Add active loops to state
    state.activeLoops = [
      {
        loopId: 'loop-test',
        taskIds: ['task-a', 'task-b'],
        iteration: 3,
        maxIterations: 20,
        reviewInterval: 5,
        lastReviewAt: 0,
        status: 'running',
        stuckIndicators: {
          sameErrorCount: 1,
          noProgressCount: 0,
          lastError: 'Test error',
          lastFileChangeIteration: 2,
          lastActivityAt: Date.now(),
        },
        output: [],
        worktreePath: '/path/to/worktree',
        phase: 'build',
      },
    ];
    state.costs.loopCosts['loop-test'] = 0.33;

    saveRun(state);
    closeDatabase();

    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.activeLoops.length, 1);

    const loop = loaded.activeLoops[0];
    assert.strictEqual(loop.loopId, 'loop-test');
    assert.deepStrictEqual(loop.taskIds, ['task-a', 'task-b']);
    assert.strictEqual(loop.iteration, 3);
    assert.strictEqual(loop.stuckIndicators.sameErrorCount, 1);
    assert.strictEqual(loop.stuckIndicators.lastError, 'Test error');
    assert.strictEqual(loop.worktreePath, '/path/to/worktree');
    assert.strictEqual(loaded.costs.loopCosts['loop-test'], 0.33);
  });

  test('loadState restores plan groups as taskGraph', () => {
    const dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: tempDir,
      maxLoops: 4,
      maxIterations: 20,
      useWorktrees: false,
    });

    saveRun(state);

    // Insert tasks and plan groups
    const db = getDatabase();
    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, status, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('task-1', state.runId, 'Task 1', 'First', 'pending', '[]', 5);
    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, status, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('task-2', state.runId, 'Task 2', 'Second', 'pending', '[]', 5);
    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, status, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('task-3', state.runId, 'Task 3', 'Third', 'pending', '["task-1", "task-2"]', 5);

    db.prepare(`
      INSERT INTO plan_groups (run_id, group_index, task_ids)
      VALUES (?, ?, ?)
    `).run(state.runId, 0, '["task-1", "task-2"]');
    db.prepare(`
      INSERT INTO plan_groups (run_id, group_index, task_ids)
      VALUES (?, ?, ?)
    `).run(state.runId, 1, '["task-3"]');

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.ok(loaded.taskGraph);
    assert.strictEqual(loaded.taskGraph.parallelGroups.length, 2);
    assert.deepStrictEqual(loaded.taskGraph.parallelGroups[0], ['task-1', 'task-2']);
    assert.deepStrictEqual(loaded.taskGraph.parallelGroups[1], ['task-3']);
  });
});
