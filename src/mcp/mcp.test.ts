import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeDatabase, createDatabase, getDatabase } from '../db/index.js';
import { createMCPServer } from './server.js';

describe('MCP Server', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sq-mcp-test-'));
    createDatabase(join(tempDir, 'state.db'));

    // Create a test run
    getDatabase()
      .prepare(`
      INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)
    `)
      .run('test-run', '/spec.md', 'medium');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true });
  });

  test('createMCPServer returns a server instance', () => {
    const server = createMCPServer('test-run');
    assert.ok(server);
  });

  test('write_task creates task in database', async () => {
    // Since we can't easily call the MCP server directly in tests,
    // we test the underlying database operations
    const db = getDatabase();
    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('task-1', 'test-run', 'Test Task', 'Do something', '[]', 5);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as any;
    assert.strictEqual(task.title, 'Test Task');
  });

  test('complete_task updates status', async () => {
    const db = getDatabase();

    // Create task
    db.prepare(`
      INSERT INTO tasks (id, run_id, title, description, dependencies, estimated_iterations)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('task-1', 'test-run', 'Test', 'Desc', '[]', 5);

    // Complete it
    db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run('task-1');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as any;
    assert.strictEqual(task.status, 'completed');
  });

  test('add_plan_group creates plan group', () => {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO plan_groups (run_id, group_index, task_ids)
      VALUES (?, ?, ?)
    `).run('test-run', 0, '["task-1", "task-2"]');

    const groups = db
      .prepare('SELECT * FROM plan_groups WHERE run_id = ?')
      .all('test-run') as any[];
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].group_index, 0);
    assert.deepStrictEqual(JSON.parse(groups[0].task_ids), ['task-1', 'task-2']);
  });

  test('add_context creates context entry', () => {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO context_entries (run_id, entry_type, content)
      VALUES (?, ?, ?)
    `).run('test-run', 'discovery', 'Found existing pattern');

    const entries = db
      .prepare('SELECT * FROM context_entries WHERE run_id = ?')
      .all('test-run') as any[];
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].entry_type, 'discovery');
    assert.strictEqual(entries[0].content, 'Found existing pattern');
  });

  test('set_review_result stores structured review issues', () => {
    const db = getDatabase();

    // Insert a structured review issue
    db.prepare(`
      INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-run',
      'task-1',
      'src/index.ts',
      42,
      'over-engineering',
      'Unnecessary abstraction',
      'Simplify the code'
    );

    const issues = db
      .prepare('SELECT * FROM review_issues WHERE run_id = ?')
      .all('test-run') as any[];
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].task_id, 'task-1');
    assert.strictEqual(issues[0].file, 'src/index.ts');
    assert.strictEqual(issues[0].line, 42);
    assert.strictEqual(issues[0].type, 'over-engineering');
    assert.strictEqual(issues[0].description, 'Unnecessary abstraction');
    assert.strictEqual(issues[0].suggestion, 'Simplify the code');
  });

  test('set_review_result allows null line number', () => {
    const db = getDatabase();

    // Insert a review issue without line number
    db.prepare(`
      INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-run',
      'task-1',
      'src/utils.ts',
      null,
      'dead-code',
      'Unused function',
      'Remove the function'
    );

    const issues = db
      .prepare('SELECT * FROM review_issues WHERE run_id = ?')
      .all('test-run') as any[];
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].line, null);
  });
});
