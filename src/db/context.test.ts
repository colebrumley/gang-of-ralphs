import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pruneContext, readContextFromDb, writeContextToDb } from './context.js';
import { closeDatabase, createDatabase, getDatabase } from './index.js';

describe('Context DB Helpers', () => {
  let tempDir: string;
  let dbPath: string;
  const runId = 'test-run-id';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'context-test-'));
    dbPath = join(tempDir, 'test.db');
    createDatabase(dbPath);
    getDatabase()
      .prepare('INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)')
      .run(runId, '/test/spec.md', 'medium');
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('writeContextToDb', () => {
    it('inserts a discovery entry', () => {
      const result = writeContextToDb(getDatabase(), {
        runId,
        type: 'discovery',
        content: 'Found existing auth middleware',
      });
      assert.ok(result.id > 0);
      const row = getDatabase().prepare('SELECT * FROM context WHERE id = ?').get(result.id) as {
        type: string;
        content: string;
      };
      assert.strictEqual(row.type, 'discovery');
      assert.strictEqual(row.content, 'Found existing auth middleware');
    });

    it('inserts a review_issue with file and line', () => {
      const result = writeContextToDb(getDatabase(), {
        runId,
        type: 'review_issue',
        content: JSON.stringify({
          issue_type: 'over-engineering',
          description: 'Too complex',
          suggestion: 'Simplify',
        }),
        taskId: 'task-1',
        file: 'src/foo.ts',
        line: 42,
      });
      assert.ok(result.id > 0);
      const row = getDatabase().prepare('SELECT * FROM context WHERE id = ?').get(result.id) as {
        file: string;
        line: number;
      };
      assert.strictEqual(row.file, 'src/foo.ts');
      assert.strictEqual(row.line, 42);
    });

    it('inserts a scratchpad entry with loop_id', () => {
      const result = writeContextToDb(getDatabase(), {
        runId,
        type: 'scratchpad',
        content: JSON.stringify({ iteration: 1, done: false, next_step: 'Fix bug' }),
        loopId: 'loop-1',
      });
      assert.ok(result.id > 0);
      const row = getDatabase().prepare('SELECT * FROM context WHERE id = ?').get(result.id) as {
        loop_id: string;
      };
      assert.strictEqual(row.loop_id, 'loop-1');
    });
  });

  describe('readContextFromDb', () => {
    beforeEach(() => {
      writeContextToDb(getDatabase(), { runId, type: 'discovery', content: 'Found auth' });
      writeContextToDb(getDatabase(), { runId, type: 'discovery', content: 'Found database' });
      writeContextToDb(getDatabase(), { runId, type: 'error', content: 'Build failed' });
      writeContextToDb(getDatabase(), {
        runId,
        type: 'review_issue',
        content: '{"issue_type":"dead-code"}',
        taskId: 'task-1',
        file: 'src/foo.ts',
      });
      writeContextToDb(getDatabase(), {
        runId,
        type: 'scratchpad',
        content: '{"iteration":1}',
        loopId: 'loop-1',
      });
    });

    it('loads all context for a run', () => {
      const { entries, total } = readContextFromDb(getDatabase(), { runId });
      assert.strictEqual(total, 5);
      assert.strictEqual(entries.length, 5);
    });

    it('filters by type', () => {
      const { entries, total } = readContextFromDb(getDatabase(), { runId, types: ['discovery'] });
      assert.strictEqual(total, 2);
      assert.ok(entries.every((e) => e.type === 'discovery'));
    });

    it('filters by multiple types', () => {
      const { entries } = readContextFromDb(getDatabase(), {
        runId,
        types: ['discovery', 'error'],
      });
      assert.strictEqual(entries.length, 3);
    });

    it('filters by taskId', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, taskId: 'task-1' });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].type, 'review_issue');
    });

    it('filters by loopId', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, loopId: 'loop-1' });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].type, 'scratchpad');
    });

    it('respects limit', () => {
      const { entries, total } = readContextFromDb(getDatabase(), { runId, limit: 2 });
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(total, 5);
    });

    it('respects offset', () => {
      const all = readContextFromDb(getDatabase(), { runId, order: 'asc' });
      const offset = readContextFromDb(getDatabase(), { runId, order: 'asc', offset: 2 });
      assert.strictEqual(offset.entries[0].id, all.entries[2].id);
    });

    it('orders by created_at desc by default', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId });
      assert.strictEqual(entries[0].type, 'scratchpad');
    });

    it('orders by created_at asc when specified', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, order: 'asc' });
      assert.strictEqual(entries[0].type, 'discovery');
      assert.strictEqual(entries[0].content, 'Found auth');
    });
  });

  describe('FTS5 search', () => {
    beforeEach(() => {
      writeContextToDb(getDatabase(), {
        runId,
        type: 'discovery',
        content: 'Found authentication middleware',
      });
      writeContextToDb(getDatabase(), {
        runId,
        type: 'discovery',
        content: 'Found database connection pool',
      });
      writeContextToDb(getDatabase(), {
        runId,
        type: 'error',
        content: 'TypeError in authentication handler',
      });
    });

    it('searches content with FTS5', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, search: 'authentication' });
      assert.strictEqual(entries.length, 2);
    });

    it('combines search with type filter', () => {
      const { entries } = readContextFromDb(getDatabase(), {
        runId,
        search: 'authentication',
        types: ['error'],
      });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].type, 'error');
    });

    it('returns empty for no matches', () => {
      const { entries, total } = readContextFromDb(getDatabase(), { runId, search: 'nonexistent' });
      assert.strictEqual(entries.length, 0);
      assert.strictEqual(total, 0);
    });
  });

  describe('pruneContext', () => {
    it('keeps only maxPerType entries per type', () => {
      for (let i = 0; i < 10; i++) {
        writeContextToDb(getDatabase(), { runId, type: 'discovery', content: `Discovery ${i}` });
      }
      for (let i = 0; i < 5; i++) {
        writeContextToDb(getDatabase(), { runId, type: 'error', content: `Error ${i}` });
      }

      pruneContext(getDatabase(), runId, 3);

      const discoveries = readContextFromDb(getDatabase(), { runId, types: ['discovery'] });
      const errors = readContextFromDb(getDatabase(), { runId, types: ['error'] });

      assert.strictEqual(discoveries.total, 3);
      assert.strictEqual(errors.total, 3);
      assert.ok(discoveries.entries[0].content.includes('9'));
    });

    it('does not prune codebase_analysis', () => {
      writeContextToDb(getDatabase(), {
        runId,
        type: 'codebase_analysis',
        content: '{"projectType":"test"}',
      });
      pruneContext(getDatabase(), runId, 0);

      const analysis = readContextFromDb(getDatabase(), { runId, types: ['codebase_analysis'] });
      assert.strictEqual(analysis.total, 1);
    });
  });
});
