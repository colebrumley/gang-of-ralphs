import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, closeDatabase, getDatabase, createRun, getTasksForRun, recordCost, addContextEntry, getContextEntries } from './index.js';

describe('Database', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'c2-test-'));
    dbPath = join(tempDir, 'state.db');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true });
  });

  test('createDatabase initializes schema', () => {
    const db = createDatabase(dbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[];

    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('runs'));
    assert.ok(tableNames.includes('tasks'));
    assert.ok(tableNames.includes('loops'));
    assert.ok(tableNames.includes('plan_groups'));
    assert.ok(tableNames.includes('phase_history'));
    assert.ok(tableNames.includes('context_entries'));
  });

  test('can create and retrieve a run', () => {
    const db = createDatabase(dbPath);

    db.prepare(`
      INSERT INTO runs (id, spec_path, effort)
      VALUES (?, ?, ?)
    `).run('run-1', '/path/to/spec.md', 'medium');

    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run-1') as any;

    assert.strictEqual(run.spec_path, '/path/to/spec.md');
    assert.strictEqual(run.effort, 'medium');
    assert.strictEqual(run.phase, 'enumerate');
  });

  test('createRun helper works', () => {
    createDatabase(dbPath);
    createRun('test-run', '/spec.md', 'high', 8, 30);

    const run = getDatabase().prepare('SELECT * FROM runs WHERE id = ?').get('test-run') as any;
    assert.strictEqual(run.effort, 'high');
    assert.strictEqual(run.max_loops, 8);
    assert.strictEqual(run.max_iterations, 30);
  });

  test('can create and retrieve tasks', () => {
    const db = createDatabase(dbPath);
    createRun('run-1', '/spec.md', 'medium');

    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('task-1', 'run-1', 'Test Task', 'Do something', '[]', 5);

    const tasks = getTasksForRun('run-1') as any[];
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].title, 'Test Task');
  });

  test('recordCost updates run and loop costs', () => {
    const db = createDatabase(dbPath);
    createRun('run-1', '/spec.md', 'medium');

    // Create a loop
    db.prepare(`
      INSERT INTO loops (id, run_id, task_ids, max_iterations, review_interval)
      VALUES (?, ?, ?, ?, ?)
    `).run('loop-1', 'run-1', '["task-1"]', 20, 5);

    // Record cost
    recordCost('run-1', 0.05, 'loop-1');
    recordCost('run-1', 0.03);

    const run = db.prepare('SELECT total_cost_usd FROM runs WHERE id = ?').get('run-1') as any;
    const loop = db.prepare('SELECT cost_usd FROM loops WHERE id = ?').get('loop-1') as any;

    assert.strictEqual(run.total_cost_usd, 0.08);
    assert.strictEqual(loop.cost_usd, 0.05);
  });

  test('context entries work', () => {
    createDatabase(dbPath);
    createRun('run-1', '/spec.md', 'medium');

    addContextEntry('run-1', 'discovery', 'Found existing code');
    addContextEntry('run-1', 'error', 'Test failed');
    addContextEntry('run-1', 'decision', 'Using strategy A');

    const all = getContextEntries('run-1') as any[];
    assert.strictEqual(all.length, 3);

    const errors = getContextEntries('run-1', 'error') as any[];
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].content, 'Test failed');
  });
});
