import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeDatabase, createDatabase } from './index.js';

describe('Database', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sq-test-'));
    dbPath = join(tempDir, 'state.db');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true });
  });

  test('createDatabase initializes schema', () => {
    const db = createDatabase(dbPath);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];

    const tableNames = tables.map((t) => t.name);
    assert.ok(tableNames.includes('runs'));
    assert.ok(tableNames.includes('tasks'));
    assert.ok(tableNames.includes('loops'));
    assert.ok(tableNames.includes('plan_groups'));
    assert.ok(tableNames.includes('phase_history'));
    assert.ok(tableNames.includes('context'));
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
});
