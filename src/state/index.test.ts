import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { writeContextToDb } from '../db/context.js';
import { closeDatabase, createDatabase, getDatabase } from '../db/index.js';
import { initializeState, loadState, saveRun } from './index.js';

describe('loadState with unified context table', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sq-context-test-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('loadState loads context from unified context table', () => {
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

    // Insert context entries into the unified context table
    const db = getDatabase();
    writeContextToDb(db, {
      runId: state.runId,
      type: 'discovery',
      content: 'Found existing auth pattern',
    });
    writeContextToDb(db, {
      runId: state.runId,
      type: 'error',
      content: 'Build failed: missing module',
    });
    writeContextToDb(db, {
      runId: state.runId,
      type: 'decision',
      content: 'Using JWT for authentication',
    });

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

  test('loadState loads review issues from unified context table', () => {
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

    // Insert review_issue entries into the unified context table
    const db = getDatabase();
    writeContextToDb(db, {
      runId: state.runId,
      type: 'review_issue',
      content: JSON.stringify({
        issue_type: 'over-engineering',
        description: 'Too complex implementation',
        suggestion: 'Simplify the logic',
      }),
      taskId: 'task-1',
      file: 'src/index.ts',
      line: 42,
    });
    writeContextToDb(db, {
      runId: state.runId,
      type: 'review_issue',
      content: JSON.stringify({
        issue_type: 'dead-code',
        description: 'Unused function',
        suggestion: 'Remove it',
      }),
      taskId: 'task-2',
      file: 'src/utils.ts',
    });

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.context.reviewIssues.length, 2);

    const issue1 = loaded.context.reviewIssues.find((i) => i.taskId === 'task-1');
    assert.ok(issue1);
    assert.strictEqual(issue1.file, 'src/index.ts');
    assert.strictEqual(issue1.line, 42);
    assert.strictEqual(issue1.type, 'over-engineering');
    assert.strictEqual(issue1.description, 'Too complex implementation');
    assert.strictEqual(issue1.suggestion, 'Simplify the logic');

    const issue2 = loaded.context.reviewIssues.find((i) => i.taskId === 'task-2');
    assert.ok(issue2);
    assert.strictEqual(issue2.file, 'src/utils.ts');
    assert.strictEqual(issue2.line, undefined);
    assert.strictEqual(issue2.type, 'dead-code');
  });

  test('loadState loads codebaseAnalysis from unified context table', () => {
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

    // Insert codebase_analysis entry into the unified context table
    const db = getDatabase();
    const analysisData = {
      projectType: 'TypeScript Node.js application',
      techStack: ['TypeScript', 'Node.js', 'SQLite'],
      directoryStructure: 'src/ contains main code',
      existingFeatures: ['CLI interface', 'State management'],
      entryPoints: ['src/index.ts'],
      patterns: ['MVC pattern', 'Dependency injection'],
      summary: 'A well-structured Node.js CLI tool',
    };
    writeContextToDb(db, {
      runId: state.runId,
      type: 'codebase_analysis',
      content: JSON.stringify(analysisData),
    });

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.ok(loaded.codebaseAnalysis);
    assert.strictEqual(loaded.codebaseAnalysis.projectType, 'TypeScript Node.js application');
    assert.deepStrictEqual(loaded.codebaseAnalysis.techStack, ['TypeScript', 'Node.js', 'SQLite']);
    assert.strictEqual(loaded.codebaseAnalysis.directoryStructure, 'src/ contains main code');
    assert.deepStrictEqual(loaded.codebaseAnalysis.existingFeatures, [
      'CLI interface',
      'State management',
    ]);
    assert.deepStrictEqual(loaded.codebaseAnalysis.entryPoints, ['src/index.ts']);
    assert.deepStrictEqual(loaded.codebaseAnalysis.patterns, [
      'MVC pattern',
      'Dependency injection',
    ]);
    assert.strictEqual(loaded.codebaseAnalysis.summary, 'A well-structured Node.js CLI tool');
  });

  test('loadState preserves chronological order for context entries', () => {
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

    // Insert entries with specific timestamps
    const db = getDatabase();
    db.prepare(`
      INSERT INTO context (run_id, type, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(state.runId, 'discovery', 'Oldest discovery', '2024-01-01 10:00:00');
    db.prepare(`
      INSERT INTO context (run_id, type, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(state.runId, 'discovery', 'Middle discovery', '2024-01-01 11:00:00');
    db.prepare(`
      INSERT INTO context (run_id, type, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run(state.runId, 'discovery', 'Newest discovery', '2024-01-01 12:00:00');

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.strictEqual(loaded.context.discoveries.length, 3);
    // Should be in chronological order (oldest first)
    assert.strictEqual(loaded.context.discoveries[0], 'Oldest discovery');
    assert.strictEqual(loaded.context.discoveries[1], 'Middle discovery');
    assert.strictEqual(loaded.context.discoveries[2], 'Newest discovery');
  });

  test('loadState does not include scratchpad entries in OrchestratorContext', () => {
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

    // Insert a scratchpad entry
    const db = getDatabase();
    writeContextToDb(db, {
      runId: state.runId,
      type: 'scratchpad',
      content: JSON.stringify({ done: 'Fixed bug', testStatus: 'pass', nextStep: 'Deploy' }),
      loopId: 'loop-1',
    });
    // Also insert a discovery to verify context still works
    writeContextToDb(db, {
      runId: state.runId,
      type: 'discovery',
      content: 'Found a pattern',
    });

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    // Scratchpad should NOT appear in any of these arrays
    assert.strictEqual(loaded.context.discoveries.length, 1);
    assert.strictEqual(loaded.context.discoveries[0], 'Found a pattern');
    assert.strictEqual(loaded.context.errors.length, 0);
    assert.strictEqual(loaded.context.decisions.length, 0);
    assert.strictEqual(loaded.context.reviewIssues.length, 0);
  });

  test('loadState prunes old context entries using pruneContext', () => {
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

    // Insert many entries
    const db = getDatabase();
    for (let i = 0; i < 600; i++) {
      db.prepare(`
        INSERT INTO context (run_id, type, content, created_at)
        VALUES (?, ?, ?, datetime('now', ? || ' seconds'))
      `).run(state.runId, 'discovery', `Discovery ${i}`, i.toString());
    }

    // Verify we have more entries than the limit before loading
    const countBefore = db
      .prepare("SELECT COUNT(*) as count FROM context WHERE run_id = ? AND type = 'discovery'")
      .get(state.runId) as { count: number };
    assert.strictEqual(countBefore.count, 600);

    closeDatabase();

    // loadState should prune old entries
    const loaded = loadState(tempDir);
    assert.ok(loaded);

    // Verify database now has only the limit (500 max per type)
    const dbAfter = getDatabase();
    const countAfter = dbAfter
      .prepare("SELECT COUNT(*) as count FROM context WHERE run_id = ? AND type = 'discovery'")
      .get(state.runId) as { count: number };
    assert.strictEqual(countAfter.count, 500);
  });

  test('loadState handles missing codebaseAnalysis gracefully', () => {
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

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    // When no codebase_analysis entry exists, it should be null
    assert.strictEqual(loaded.codebaseAnalysis, null);
  });

  test('loadState prefers context table codebaseAnalysis over runs table', () => {
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

    // Set codebaseAnalysis in runs table (old location)
    const oldAnalysis = {
      projectType: 'Old analysis from runs table',
      techStack: ['Old'],
      directoryStructure: 'old',
      existingFeatures: [],
      entryPoints: [],
      patterns: [],
      summary: 'Old',
    };
    state.codebaseAnalysis = oldAnalysis;
    saveRun(state);

    // Insert new codebase_analysis in context table
    const db = getDatabase();
    const newAnalysis = {
      projectType: 'New analysis from context table',
      techStack: ['New'],
      directoryStructure: 'new',
      existingFeatures: [],
      entryPoints: [],
      patterns: [],
      summary: 'New',
    };
    writeContextToDb(db, {
      runId: state.runId,
      type: 'codebase_analysis',
      content: JSON.stringify(newAnalysis),
    });

    closeDatabase();
    const loaded = loadState(tempDir);

    assert.ok(loaded);
    assert.ok(loaded.codebaseAnalysis);
    // Should use the context table version
    assert.strictEqual(loaded.codebaseAnalysis.projectType, 'New analysis from context table');
  });
});
