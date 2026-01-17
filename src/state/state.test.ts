import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeState, saveRun, loadState } from './index.js';
import { createDatabase, closeDatabase, getDatabase } from '../db/index.js';

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
    `).run(state.runId, 'task-1', 'src/index.ts', 42, 'over-engineering', 'Too complex', 'Simplify');
    db.prepare(`
      INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(state.runId, 'task-2', 'src/utils.ts', null, 'dead-code', 'Unused', 'Remove');

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.context.reviewIssues.length, 2);

    const issue1 = loaded.context.reviewIssues.find(i => i.taskId === 'task-1');
    assert.ok(issue1);
    assert.strictEqual(issue1.file, 'src/index.ts');
    assert.strictEqual(issue1.line, 42);
    assert.strictEqual(issue1.type, 'over-engineering');
    assert.strictEqual(issue1.description, 'Too complex');
    assert.strictEqual(issue1.suggestion, 'Simplify');

    const issue2 = loaded.context.reviewIssues.find(i => i.taskId === 'task-2');
    assert.ok(issue2);
    assert.strictEqual(issue2.file, 'src/utils.ts');
    assert.strictEqual(issue2.line, undefined);
    assert.strictEqual(issue2.type, 'dead-code');
  });
});
