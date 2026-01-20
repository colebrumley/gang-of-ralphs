# Unified Context Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate context storage from three locations (SQLite tables, scratchpad files, runs.codebase_analysis) into a single unified `context` table with FTS5 search.

**Architecture:** Replace `context_entries`, `review_issues` tables and scratchpad files with one `context` table. Replace 5+ MCP tools with 2 primitives (`write_context`, `read_context`). Add FTS5 for full-text search capability.

**Tech Stack:** SQLite, FTS5, TypeScript, Zod

---

## Task 1: Add Unified Context Schema

**Files:**
- Modify: `src/db/schema.sql:77-99` (replace context_entries and review_issues)

**Step 1: Write the new context table schema**

Replace the `context_entries` and `review_issues` table definitions with:

```sql
-- Context: unified storage for all context types
CREATE TABLE IF NOT EXISTS context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL CHECK (type IN ('discovery', 'error', 'decision', 'review_issue', 'scratchpad', 'codebase_analysis')),
  content TEXT NOT NULL,
  task_id TEXT,
  loop_id TEXT,
  file TEXT,
  line INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_context_run ON context(run_id);
CREATE INDEX IF NOT EXISTS idx_context_type ON context(run_id, type);
CREATE INDEX IF NOT EXISTS idx_context_task ON context(run_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_loop ON context(run_id, loop_id) WHERE loop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_file ON context(run_id, file) WHERE file IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_created ON context(run_id, created_at DESC);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  content,
  content='context',
  content_rowid='id'
);

-- Keep FTS in sync with main table
CREATE TRIGGER IF NOT EXISTS context_fts_insert AFTER INSERT ON context BEGIN
  INSERT INTO context_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS context_fts_delete AFTER DELETE ON context BEGIN
  INSERT INTO context_fts(context_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
```

**Step 2: Remove old table definitions**

Delete these lines from schema.sql:
- Lines 77-84: `context_entries` table
- Lines 87-99: `review_issues` table
- Line 136: `idx_review_issues_run` index
- Line 137: `idx_review_issues_loop` index

**Step 3: Remove codebase_analysis from runs table**

Remove line 20 from the `runs` table definition:
```sql
  codebase_analysis TEXT  -- JSON serialized CodebaseAnalysis
```

**Step 4: Run typecheck to verify schema file syntax**

Run: `npm run typecheck`
Expected: PASS (schema.sql isn't typechecked, but ensures no imports broke)

**Step 5: Commit**

```bash
git add src/db/schema.sql
git commit -m "schema: add unified context table with FTS5"
```

---

## Task 2: Create Context DB Helpers

**Files:**
- Create: `src/db/context.ts`
- Create: `src/db/context.test.ts`

**Step 1: Write failing test for writeContextToDb**

```typescript
// src/db/context.test.ts
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, createDatabase, getDatabase } from './index.js';
import { writeContextToDb, readContextFromDb } from './context.js';

describe('Context DB Helpers', () => {
  let tempDir: string;
  let dbPath: string;
  const runId = 'test-run-id';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'context-test-'));
    dbPath = join(tempDir, 'test.db');
    createDatabase(dbPath);
    // Create a run for foreign key
    getDatabase().prepare('INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)').run(runId, '/test/spec.md', 'medium');
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

      const row = getDatabase().prepare('SELECT * FROM context WHERE id = ?').get(result.id) as { type: string; content: string };
      assert.strictEqual(row.type, 'discovery');
      assert.strictEqual(row.content, 'Found existing auth middleware');
    });

    it('inserts a review_issue with file and line', () => {
      const result = writeContextToDb(getDatabase(), {
        runId,
        type: 'review_issue',
        content: JSON.stringify({ issue_type: 'over-engineering', description: 'Too complex', suggestion: 'Simplify' }),
        taskId: 'task-1',
        file: 'src/foo.ts',
        line: 42,
      });
      assert.ok(result.id > 0);

      const row = getDatabase().prepare('SELECT * FROM context WHERE id = ?').get(result.id) as { file: string; line: number };
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

      const row = getDatabase().prepare('SELECT * FROM context WHERE id = ?').get(result.id) as { loop_id: string };
      assert.strictEqual(row.loop_id, 'loop-1');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/db/context.test.ts`
Expected: FAIL with "Cannot find module './context.js'"

**Step 3: Write minimal writeContextToDb implementation**

```typescript
// src/db/context.ts
import type { Database } from 'better-sqlite3';

export interface WriteContextOptions {
  runId: string;
  type: 'discovery' | 'error' | 'decision' | 'review_issue' | 'scratchpad' | 'codebase_analysis';
  content: string;
  taskId?: string;
  loopId?: string;
  file?: string;
  line?: number;
}

export function writeContextToDb(db: Database, entry: WriteContextOptions): { id: number } {
  const result = db.prepare(`
    INSERT INTO context (run_id, type, content, task_id, loop_id, file, line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.runId,
    entry.type,
    entry.content,
    entry.taskId ?? null,
    entry.loopId ?? null,
    entry.file ?? null,
    entry.line ?? null
  );

  return { id: Number(result.lastInsertRowid) };
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test src/db/context.test.ts`
Expected: PASS

**Step 5: Write failing test for readContextFromDb**

Add to `src/db/context.test.ts`:

```typescript
  describe('readContextFromDb', () => {
    beforeEach(() => {
      // Seed some context entries
      writeContextToDb(getDatabase(), { runId, type: 'discovery', content: 'Found auth' });
      writeContextToDb(getDatabase(), { runId, type: 'discovery', content: 'Found database' });
      writeContextToDb(getDatabase(), { runId, type: 'error', content: 'Build failed' });
      writeContextToDb(getDatabase(), { runId, type: 'review_issue', content: '{"issue_type":"dead-code"}', taskId: 'task-1', file: 'src/foo.ts' });
      writeContextToDb(getDatabase(), { runId, type: 'scratchpad', content: '{"iteration":1}', loopId: 'loop-1' });
    });

    it('loads all context for a run', () => {
      const { entries, total } = readContextFromDb(getDatabase(), { runId });
      assert.strictEqual(total, 5);
      assert.strictEqual(entries.length, 5);
    });

    it('filters by type', () => {
      const { entries, total } = readContextFromDb(getDatabase(), { runId, types: ['discovery'] });
      assert.strictEqual(total, 2);
      assert.ok(entries.every(e => e.type === 'discovery'));
    });

    it('filters by multiple types', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, types: ['discovery', 'error'] });
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
      // Last inserted should be first
      assert.strictEqual(entries[0].type, 'scratchpad');
    });

    it('orders by created_at asc when specified', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, order: 'asc' });
      // First inserted should be first
      assert.strictEqual(entries[0].type, 'discovery');
      assert.strictEqual(entries[0].content, 'Found auth');
    });
  });
```

**Step 6: Run test to verify it fails**

Run: `npx tsx --test src/db/context.test.ts`
Expected: FAIL with "readContextFromDb is not a function" or similar

**Step 7: Write readContextFromDb implementation**

Add to `src/db/context.ts`:

```typescript
export interface ReadContextOptions {
  runId: string;
  types?: string[];
  taskId?: string;
  loopId?: string;
  file?: string;
  search?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface ContextEntry {
  id: number;
  type: string;
  content: string;
  task_id: string | null;
  loop_id: string | null;
  file: string | null;
  line: number | null;
  created_at: string;
}

export interface ReadContextResult {
  entries: ContextEntry[];
  total: number;
}

export function readContextFromDb(db: Database, opts: ReadContextOptions): ReadContextResult {
  const { runId, types, taskId, loopId, file, search, limit = 500, offset = 0, order = 'desc' } = opts;

  const conditions: string[] = ['c.run_id = ?'];
  const params: unknown[] = [runId];

  if (types?.length) {
    conditions.push(`c.type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (taskId) {
    conditions.push('c.task_id = ?');
    params.push(taskId);
  }
  if (loopId) {
    conditions.push('c.loop_id = ?');
    params.push(loopId);
  }
  if (file) {
    conditions.push('c.file = ?');
    params.push(file);
  }

  const whereClause = conditions.join(' AND ');
  let query: string;
  let countQuery: string;

  if (search) {
    // FTS5 join for full-text search
    query = `
      SELECT c.* FROM context c
      JOIN context_fts fts ON c.id = fts.rowid
      WHERE ${whereClause}
        AND context_fts MATCH ?
      ORDER BY rank, c.created_at ${order.toUpperCase()}
      LIMIT ? OFFSET ?
    `;
    countQuery = `
      SELECT COUNT(*) as total FROM context c
      JOIN context_fts fts ON c.id = fts.rowid
      WHERE ${whereClause}
        AND context_fts MATCH ?
    `;
    const entries = db.prepare(query).all(...params, search, limit, offset) as ContextEntry[];
    const { total } = db.prepare(countQuery).get(...params, search) as { total: number };
    return { entries, total };
  } else {
    query = `
      SELECT * FROM context c
      WHERE ${whereClause}
      ORDER BY c.created_at ${order.toUpperCase()}
      LIMIT ? OFFSET ?
    `;
    countQuery = `
      SELECT COUNT(*) as total FROM context c
      WHERE ${whereClause}
    `;
    const entries = db.prepare(query).all(...params, limit, offset) as ContextEntry[];
    const { total } = db.prepare(countQuery).get(...params) as { total: number };
    return { entries, total };
  }
}
```

**Step 8: Run test to verify it passes**

Run: `npx tsx --test src/db/context.test.ts`
Expected: PASS

**Step 9: Write failing test for FTS5 search**

Add to `src/db/context.test.ts`:

```typescript
  describe('FTS5 search', () => {
    beforeEach(() => {
      writeContextToDb(getDatabase(), { runId, type: 'discovery', content: 'Found authentication middleware' });
      writeContextToDb(getDatabase(), { runId, type: 'discovery', content: 'Found database connection pool' });
      writeContextToDb(getDatabase(), { runId, type: 'error', content: 'TypeError in authentication handler' });
    });

    it('searches content with FTS5', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, search: 'authentication' });
      assert.strictEqual(entries.length, 2);
    });

    it('combines search with type filter', () => {
      const { entries } = readContextFromDb(getDatabase(), { runId, search: 'authentication', types: ['error'] });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].type, 'error');
    });

    it('returns empty for no matches', () => {
      const { entries, total } = readContextFromDb(getDatabase(), { runId, search: 'nonexistent' });
      assert.strictEqual(entries.length, 0);
      assert.strictEqual(total, 0);
    });
  });
```

**Step 10: Run test to verify it passes**

Run: `npx tsx --test src/db/context.test.ts`
Expected: PASS (FTS5 is already implemented)

**Step 11: Write failing test for pruneContext**

Add to `src/db/context.test.ts`:

```typescript
  describe('pruneContext', () => {
    it('keeps only maxPerType entries per type', () => {
      // Insert 10 discoveries
      for (let i = 0; i < 10; i++) {
        writeContextToDb(getDatabase(), { runId, type: 'discovery', content: `Discovery ${i}` });
      }
      // Insert 5 errors
      for (let i = 0; i < 5; i++) {
        writeContextToDb(getDatabase(), { runId, type: 'error', content: `Error ${i}` });
      }

      pruneContext(getDatabase(), runId, 3);

      const discoveries = readContextFromDb(getDatabase(), { runId, types: ['discovery'] });
      const errors = readContextFromDb(getDatabase(), { runId, types: ['error'] });

      assert.strictEqual(discoveries.total, 3);
      assert.strictEqual(errors.total, 3);
      // Should keep the most recent (highest numbered)
      assert.ok(discoveries.entries[0].content.includes('9'));
    });

    it('does not prune codebase_analysis', () => {
      writeContextToDb(getDatabase(), { runId, type: 'codebase_analysis', content: '{"projectType":"test"}' });
      pruneContext(getDatabase(), runId, 0);

      const analysis = readContextFromDb(getDatabase(), { runId, types: ['codebase_analysis'] });
      assert.strictEqual(analysis.total, 1);
    });
  });
```

**Step 12: Run test to verify it fails**

Run: `npx tsx --test src/db/context.test.ts`
Expected: FAIL with "pruneContext is not a function"

**Step 13: Write pruneContext implementation**

Add to `src/db/context.ts`:

```typescript
export function pruneContext(db: Database, runId: string, maxPerType: number = 500): void {
  const types = ['discovery', 'error', 'decision', 'review_issue', 'scratchpad'];

  for (const type of types) {
    db.prepare(`
      DELETE FROM context
      WHERE run_id = ? AND type = ? AND id NOT IN (
        SELECT id FROM context
        WHERE run_id = ? AND type = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
    `).run(runId, type, runId, type, maxPerType);
  }
  // codebase_analysis is not pruned - only one per run
}
```

**Step 14: Run test to verify it passes**

Run: `npx tsx --test src/db/context.test.ts`
Expected: PASS

**Step 15: Commit**

```bash
git add src/db/context.ts src/db/context.test.ts
git commit -m "feat: add unified context db helpers with FTS5 search"
```

---

## Task 3: Add MCP Tool Schemas

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/tools.test.ts`

**Step 1: Write failing test for WriteContextSchema**

Add to `src/mcp/tools.test.ts`:

```typescript
describe('WriteContextSchema', () => {
  it('accepts valid discovery context', () => {
    const result = WriteContextSchema.safeParse({
      type: 'discovery',
      content: 'Found existing auth middleware',
    });
    assert.ok(result.success);
  });

  it('accepts review_issue with all fields', () => {
    const result = WriteContextSchema.safeParse({
      type: 'review_issue',
      content: JSON.stringify({ issue_type: 'dead-code', description: 'Unused', suggestion: 'Remove' }),
      task_id: 'task-1',
      file: 'src/foo.ts',
      line: 42,
    });
    assert.ok(result.success);
  });

  it('accepts scratchpad with loop_id', () => {
    const result = WriteContextSchema.safeParse({
      type: 'scratchpad',
      content: JSON.stringify({ iteration: 1, done: false }),
      loop_id: 'loop-1',
    });
    assert.ok(result.success);
  });

  it('rejects invalid type', () => {
    const result = WriteContextSchema.safeParse({
      type: 'invalid',
      content: 'test',
    });
    assert.ok(!result.success);
  });

  it('rejects missing content', () => {
    const result = WriteContextSchema.safeParse({
      type: 'discovery',
    });
    assert.ok(!result.success);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/mcp/tools.test.ts`
Expected: FAIL with "WriteContextSchema is not defined"

**Step 3: Add WriteContextSchema**

Add to `src/mcp/tools.ts`:

```typescript
export const WriteContextSchema = z.object({
  type: z.enum(['discovery', 'error', 'decision', 'review_issue', 'scratchpad', 'codebase_analysis']).describe('The type of context being written'),
  content: z.string().describe('The content. Plain string for simple types, JSON string for structured types'),
  task_id: z.string().optional().describe('Associated task ID'),
  loop_id: z.string().optional().describe('Associated loop ID'),
  file: z.string().optional().describe('Associated file path'),
  line: z.number().optional().describe('Associated line number'),
});

export type WriteContext = z.infer<typeof WriteContextSchema>;
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test src/mcp/tools.test.ts`
Expected: PASS

**Step 5: Write failing test for ReadContextSchema**

Add to `src/mcp/tools.test.ts`:

```typescript
describe('ReadContextSchema', () => {
  it('accepts empty object (all optional)', () => {
    const result = ReadContextSchema.safeParse({});
    assert.ok(result.success);
  });

  it('accepts types array', () => {
    const result = ReadContextSchema.safeParse({
      types: ['discovery', 'error'],
    });
    assert.ok(result.success);
  });

  it('accepts all filter options', () => {
    const result = ReadContextSchema.safeParse({
      types: ['review_issue'],
      task_id: 'task-1',
      loop_id: 'loop-1',
      file: 'src/foo.ts',
      search: 'authentication',
      limit: 100,
      offset: 10,
      order: 'asc',
    });
    assert.ok(result.success);
  });

  it('defaults limit to 500', () => {
    const result = ReadContextSchema.parse({});
    assert.strictEqual(result.limit, 500);
  });

  it('defaults order to desc', () => {
    const result = ReadContextSchema.parse({});
    assert.strictEqual(result.order, 'desc');
  });

  it('rejects invalid order', () => {
    const result = ReadContextSchema.safeParse({ order: 'invalid' });
    assert.ok(!result.success);
  });
});
```

**Step 6: Run test to verify it fails**

Run: `npx tsx --test src/mcp/tools.test.ts`
Expected: FAIL with "ReadContextSchema is not defined"

**Step 7: Add ReadContextSchema**

Add to `src/mcp/tools.ts`:

```typescript
export const ReadContextSchema = z.object({
  types: z.array(z.string()).optional().describe('Filter by context types'),
  task_id: z.string().optional().describe('Filter by task ID'),
  loop_id: z.string().optional().describe('Filter by loop ID'),
  file: z.string().optional().describe('Filter by file path'),
  search: z.string().optional().describe('Full-text search query'),
  limit: z.number().default(500).describe('Max entries to return'),
  offset: z.number().default(0).describe('Skip first N entries'),
  order: z.enum(['asc', 'desc']).default('desc').describe('Sort by created_at'),
});

export type ReadContext = z.infer<typeof ReadContextSchema>;
```

**Step 8: Run test to verify it passes**

Run: `npx tsx --test src/mcp/tools.test.ts`
Expected: PASS

**Step 9: Commit**

```bash
git add src/mcp/tools.ts src/mcp/tools.test.ts
git commit -m "feat: add WriteContextSchema and ReadContextSchema"
```

---

## Task 4: Implement MCP write_context Tool

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/mcp.test.ts`

**Step 1: Write failing test for write_context tool**

Add to `src/mcp/mcp.test.ts`:

```typescript
it('write_context creates context entry', async () => {
  const server = createMCPServer(runId, dbPath);

  // Simulate calling the tool
  const handler = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })._requestHandlers.get('tools/call');
  const result = await handler!({
    params: {
      name: 'write_context',
      arguments: {
        type: 'discovery',
        content: 'Found existing auth',
      },
    },
  }) as { content: Array<{ text: string }> };

  assert.ok(result.content[0].text.includes('Context written'));

  // Verify in database
  const row = db.prepare('SELECT * FROM context WHERE run_id = ? AND type = ?').get(runId, 'discovery') as { content: string };
  assert.strictEqual(row.content, 'Found existing auth');
});

it('write_context creates scratchpad with loop_id', async () => {
  const server = createMCPServer(runId, dbPath);

  const handler = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })._requestHandlers.get('tools/call');
  await handler!({
    params: {
      name: 'write_context',
      arguments: {
        type: 'scratchpad',
        content: JSON.stringify({ iteration: 1, done: false, next_step: 'Fix bug' }),
        loop_id: 'test-loop',
      },
    },
  });

  const row = db.prepare('SELECT * FROM context WHERE run_id = ? AND type = ?').get(runId, 'scratchpad') as { loop_id: string };
  assert.strictEqual(row.loop_id, 'test-loop');
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/mcp/mcp.test.ts`
Expected: FAIL with "Unknown tool: write_context"

**Step 3: Add write_context tool definition**

In `src/mcp/server.ts`, add to the tools array in ListToolsRequestSchema handler (around line 67):

```typescript
{
  name: 'write_context',
  description: 'Write context to the shared context store. Use for discoveries, errors, decisions, review issues, scratchpad entries, and codebase analysis.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['discovery', 'error', 'decision', 'review_issue', 'scratchpad', 'codebase_analysis'],
        description: 'The type of context being written',
      },
      content: {
        type: 'string',
        description: 'The content. Plain string for simple types, JSON string for structured types',
      },
      task_id: { type: 'string', description: 'Associated task ID (optional)' },
      loop_id: { type: 'string', description: 'Associated loop ID (optional)' },
      file: { type: 'string', description: 'Associated file path (optional)' },
      line: { type: 'number', description: 'Associated line number (optional)' },
    },
    required: ['type', 'content'],
  },
},
```

**Step 4: Add write_context case handler**

In `src/mcp/server.ts`, add to the switch statement (around line 413):

```typescript
case 'write_context': {
  const ctx = WriteContextSchema.parse(args);
  const { id } = writeContextToDb(db, {
    runId,
    type: ctx.type,
    content: ctx.content,
    taskId: ctx.task_id,
    loopId: ctx.loop_id,
    file: ctx.file,
    line: ctx.line,
  });
  result = { content: [{ type: 'text', text: `Context written (id: ${id}, type: ${ctx.type})` }] };
  break;
}
```

Add imports at the top:
```typescript
import { WriteContextSchema } from './tools.js';
import { writeContextToDb } from '../db/context.js';
```

**Step 5: Run test to verify it passes**

Run: `npx tsx --test src/mcp/mcp.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/mcp/server.ts src/mcp/mcp.test.ts
git commit -m "feat: add write_context MCP tool"
```

---

## Task 5: Implement MCP read_context Tool

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/mcp.test.ts`

**Step 1: Write failing test for read_context tool**

Add to `src/mcp/mcp.test.ts`:

```typescript
it('read_context returns all context for run', async () => {
  // Seed some context
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(runId, 'discovery', 'Found auth');
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(runId, 'error', 'Build failed');

  const server = createMCPServer(runId, dbPath);
  const handler = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })._requestHandlers.get('tools/call');
  const result = await handler!({
    params: {
      name: 'read_context',
      arguments: {},
    },
  }) as { content: Array<{ text: string }> };

  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.total, 2);
  assert.strictEqual(response.entries.length, 2);
});

it('read_context filters by type', async () => {
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(runId, 'discovery', 'Found auth');
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(runId, 'error', 'Build failed');

  const server = createMCPServer(runId, dbPath);
  const handler = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })._requestHandlers.get('tools/call');
  const result = await handler!({
    params: {
      name: 'read_context',
      arguments: { types: ['discovery'] },
    },
  }) as { content: Array<{ text: string }> };

  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.total, 1);
  assert.strictEqual(response.entries[0].type, 'discovery');
});

it('read_context supports full-text search', async () => {
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(runId, 'discovery', 'Found authentication middleware');
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(runId, 'discovery', 'Found database pool');

  const server = createMCPServer(runId, dbPath);
  const handler = (server as unknown as { _requestHandlers: Map<string, (req: unknown) => Promise<unknown>> })._requestHandlers.get('tools/call');
  const result = await handler!({
    params: {
      name: 'read_context',
      arguments: { search: 'authentication' },
    },
  }) as { content: Array<{ text: string }> };

  const response = JSON.parse(result.content[0].text);
  assert.strictEqual(response.total, 1);
  assert.ok(response.entries[0].content.includes('authentication'));
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/mcp/mcp.test.ts`
Expected: FAIL with "Unknown tool: read_context"

**Step 3: Add read_context tool definition**

In `src/mcp/server.ts`, add to the tools array:

```typescript
{
  name: 'read_context',
  description: 'Read context from the shared context store. Supports filtering by type, task, loop, file, and full-text search.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by context types (optional)',
      },
      task_id: { type: 'string', description: 'Filter by task ID (optional)' },
      loop_id: { type: 'string', description: 'Filter by loop ID (optional)' },
      file: { type: 'string', description: 'Filter by file path (optional)' },
      search: { type: 'string', description: 'Full-text search query (optional)' },
      limit: { type: 'number', description: 'Max entries to return (default: 500)' },
      offset: { type: 'number', description: 'Skip first N entries (default: 0)' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort by created_at (default: desc)' },
    },
    required: [],
  },
},
```

**Step 4: Add read_context case handler**

In `src/mcp/server.ts`, add to the switch statement:

```typescript
case 'read_context': {
  const opts = ReadContextSchema.parse(args);
  const { entries, total } = readContextFromDb(db, {
    runId,
    types: opts.types,
    taskId: opts.task_id,
    loopId: opts.loop_id,
    file: opts.file,
    search: opts.search,
    limit: opts.limit,
    offset: opts.offset,
    order: opts.order,
  });
  result = { content: [{ type: 'text', text: JSON.stringify({ entries, total }) }] };
  break;
}
```

Add import:
```typescript
import { ReadContextSchema, WriteContextSchema } from './tools.js';
import { readContextFromDb, writeContextToDb } from '../db/context.js';
```

**Step 5: Run test to verify it passes**

Run: `npx tsx --test src/mcp/mcp.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/mcp/server.ts src/mcp/mcp.test.ts
git commit -m "feat: add read_context MCP tool with FTS5 search"
```

---

## Task 6: Update loadState to Use Unified Context

**Files:**
- Modify: `src/state/index.ts`
- Modify: `src/state/index.test.ts`

**Step 1: Write failing test for loadState with unified context**

Add to or modify in `src/state/index.test.ts`:

```typescript
it('loadState loads context from unified context table', () => {
  // First save a run
  const state = initializeState({
    specPath: '/test/spec.md',
    effort: 'medium',
    stateDir: tempDir,
    maxLoops: 4,
    maxIterations: 20,
  });
  saveRun(state);

  // Insert context entries using new unified table
  const db = getDatabase();
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(state.runId, 'discovery', 'Found auth');
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(state.runId, 'error', 'Build failed');
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(state.runId, 'decision', 'Using JWT');

  // Reload state
  closeDatabase();
  const loaded = loadState(tempDir);

  assert.ok(loaded);
  assert.deepStrictEqual(loaded.context.discoveries, ['Found auth']);
  assert.deepStrictEqual(loaded.context.errors, ['Build failed']);
  assert.deepStrictEqual(loaded.context.decisions, ['Using JWT']);
});

it('loadState loads review issues from unified context table', () => {
  const state = initializeState({
    specPath: '/test/spec.md',
    effort: 'medium',
    stateDir: tempDir,
    maxLoops: 4,
    maxIterations: 20,
  });
  saveRun(state);

  const db = getDatabase();
  const issueContent = JSON.stringify({
    issue_type: 'over-engineering',
    description: 'Too complex',
    suggestion: 'Simplify',
  });
  db.prepare('INSERT INTO context (run_id, type, content, task_id, file, line) VALUES (?, ?, ?, ?, ?, ?)').run(
    state.runId, 'review_issue', issueContent, 'task-1', 'src/foo.ts', 42
  );

  closeDatabase();
  const loaded = loadState(tempDir);

  assert.ok(loaded);
  assert.strictEqual(loaded.context.reviewIssues.length, 1);
  assert.strictEqual(loaded.context.reviewIssues[0].taskId, 'task-1');
  assert.strictEqual(loaded.context.reviewIssues[0].file, 'src/foo.ts');
  assert.strictEqual(loaded.context.reviewIssues[0].line, 42);
  assert.strictEqual(loaded.context.reviewIssues[0].type, 'over-engineering');
});

it('loadState loads codebaseAnalysis from unified context table', () => {
  const state = initializeState({
    specPath: '/test/spec.md',
    effort: 'medium',
    stateDir: tempDir,
    maxLoops: 4,
    maxIterations: 20,
  });
  saveRun(state);

  const db = getDatabase();
  const analysisContent = JSON.stringify({
    projectType: 'Node.js CLI',
    techStack: ['TypeScript', 'SQLite'],
    directoryStructure: 'src/',
    existingFeatures: ['auth'],
    entryPoints: ['bin/sq'],
    patterns: ['MCP'],
    summary: 'Test project',
  });
  db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(
    state.runId, 'codebase_analysis', analysisContent
  );

  closeDatabase();
  const loaded = loadState(tempDir);

  assert.ok(loaded);
  assert.ok(loaded.codebaseAnalysis);
  assert.strictEqual(loaded.codebaseAnalysis.projectType, 'Node.js CLI');
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/state/index.test.ts`
Expected: FAIL (context table doesn't exist, or queries against old tables)

**Step 3: Update loadState to use readContextFromDb**

Modify `src/state/index.ts`:

1. Add import at top:
```typescript
import { readContextFromDb, pruneContext } from '../db/context.js';
```

2. Replace the context loading section (around lines 537-589) with:

```typescript
// Load context entries using unified context table
const { entries: contextEntries } = readContextFromDb(db, {
  runId: run.id,
  limit: 2000,
  order: 'asc',
});

// Partition by type for OrchestratorContext shape
const discoveries: string[] = [];
const errors: string[] = [];
const decisions: string[] = [];
const reviewIssues: ReviewIssue[] = [];
let codebaseAnalysis: CodebaseAnalysis | null = null;

for (const entry of contextEntries) {
  switch (entry.type) {
    case 'discovery':
      discoveries.push(entry.content);
      break;
    case 'error':
      errors.push(entry.content);
      break;
    case 'decision':
      decisions.push(entry.content);
      break;
    case 'review_issue': {
      const parsed = JSON.parse(entry.content);
      reviewIssues.push({
        taskId: entry.task_id ?? undefined,
        file: entry.file ?? '',
        line: entry.line ?? undefined,
        type: parsed.issue_type,
        description: parsed.description,
        suggestion: parsed.suggestion,
      });
      break;
    }
    case 'codebase_analysis':
      codebaseAnalysis = SetCodebaseAnalysisSchema.parse(JSON.parse(entry.content));
      break;
    // scratchpad entries not loaded into OrchestratorContext - agents read them via read_context
  }
}

// Prune old context entries
pruneContext(db, run.id);
```

3. Remove old functions:
- `loadContextEntries` function
- `pruneContextEntries` function
- `pruneReviewIssues` function

4. Update the return statement to use the new variables.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test src/state/index.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm run test`
Expected: Some tests may fail due to old table references

**Step 6: Commit**

```bash
git add src/state/index.ts src/state/index.test.ts
git commit -m "refactor: update loadState to use unified context table"
```

---

## Task 7: Remove Old MCP Tools

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/mcp.test.ts`

**Step 1: Remove old tool definitions from server.ts**

Remove these tool definitions from the tools array in ListToolsRequestSchema handler:
- `add_context` (lines ~158-173)
- `set_review_result` (lines ~174-219)
- `set_loop_review_result` (lines ~221-268)
- `set_codebase_analysis` (lines ~337-385)
- `write_scratchpad` (lines ~387-401)

**Step 2: Remove old tool case handlers from server.ts**

Remove these case handlers from the switch statement:
- `case 'add_context':` handler
- `case 'set_review_result':` handler
- `case 'set_loop_review_result':` handler
- `case 'set_codebase_analysis':` handler
- `case 'write_scratchpad':` handler

**Step 3: Remove old schemas from tools.ts**

Remove these schema definitions and their type exports:
- `AddContextSchema` and `AddContext` type
- `ReviewIssueSchema` (keep LoopReviewIssueSchema if still used elsewhere, or consolidate)
- `SetReviewResultSchema` and `SetReviewResult` type
- `LoopReviewIssueSchema` and `LoopReviewIssue` type
- `SetLoopReviewResultSchema` and `SetLoopReviewResult` type
- `SetCodebaseAnalysisSchema` (note: keep if used for validation in loadState)
- `WriteScratchpadSchema` and `WriteScratchpad` type

**Step 4: Update imports in server.ts**

Remove unused imports:
```typescript
// Remove these from imports
AddContextSchema,
SetReviewResultSchema,
SetLoopReviewResultSchema,
SetCodebaseAnalysisSchema,
WriteScratchpadSchema,
```

**Step 5: Update tests in mcp.test.ts**

Remove or update tests for removed tools:
- `add_context creates context entry` - remove
- `set_review_result stores structured review issues` - remove
- `set_review_result allows null line number` - remove

**Step 6: Run tests**

Run: `npm run test`
Expected: PASS (with remaining valid tests)

**Step 7: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools.ts src/mcp/mcp.test.ts
git commit -m "refactor: remove old context MCP tools"
```

---

## Task 8: Update Agent Prompts

**Files:**
- Modify: `src/agents/prompts/build.ts` (or equivalent prompt files)
- Check: Other prompt files that reference old tools

**Step 1: Find prompt files referencing old tools**

Run: `grep -r "add_context\|set_review_result\|write_scratchpad\|set_codebase_analysis" src/`

**Step 2: Update BUILD prompt for new context tools**

Replace references to old tools with new tool documentation:

```markdown
## Context Tools

You have two tools for managing shared context:

### write_context
Write discoveries, errors, decisions, review issues, or scratchpad entries.

Types:
- `discovery`: Something learned about the codebase
- `error`: An error or problem encountered
- `decision`: A decision made and why
- `review_issue`: A code quality issue (content is JSON with issue_type, description, suggestion)
- `scratchpad`: Iteration progress (content is JSON with iteration, done, test_status, next_step, blockers, attempted)
- `codebase_analysis`: Project analysis (content is JSON with project_type, tech_stack, etc.)

### read_context
Query existing context. Supports filtering and full-text search.

Examples:
- All errors: `read_context({ types: ['error'] })`
- Issues for a file: `read_context({ types: ['review_issue'], file: 'src/auth.ts' })`
- Search for keyword: `read_context({ search: 'timeout' })`
- Your scratchpad history: `read_context({ types: ['scratchpad'], loop_id: '{{loopId}}', limit: 10 })`
```

**Step 3: Update scratchpad/iteration instructions**

Replace old scratchpad instructions with:

```markdown
## Iteration Progress

Before each iteration, read your scratchpad history:
`read_context({ types: ['scratchpad'], loop_id: '{{loopId}}', limit: 10, order: 'desc' })`

Check the `attempted` arrays across recent entries:
1. **Don't repeat yourself** - If something is already in `attempted`, don't try it again. Find a different approach.
2. **Stuck detection** - If you've tried 3+ distinct approaches without progress (test_status still failing, same blocker persists), you're stuck. Write a scratchpad entry with `done: false` and clearly describe the blocker so a human or reviewer can help.

After meaningful progress, write a scratchpad entry documenting:
- What you tried (add to `attempted`)
- Current `test_status`
- `next_step` you plan to take
- Any `blockers` you've identified
```

**Step 4: Update ANALYZE prompt**

Replace `set_codebase_analysis` references with:

```markdown
When analysis is complete, store results using:
`write_context({ type: 'codebase_analysis', content: JSON.stringify({ project_type, tech_stack, directory_structure, existing_features, entry_points, patterns, summary }) })`
```

**Step 5: Update REVIEW prompt**

Replace `set_review_result` references with new context approach. Review issues should be written as:

```markdown
For each issue found, write:
`write_context({ type: 'review_issue', content: JSON.stringify({ issue_type, description, suggestion }), task_id, file, line })`
```

**Step 6: Commit**

```bash
git add src/agents/prompts/
git commit -m "docs: update agent prompts for unified context tools"
```

---

## Task 9: Final Cleanup and Test Suite Verification

**Files:**
- All modified files
- Run full test suite

**Step 1: Remove any remaining old table references**

Search for remaining references:
```bash
grep -r "context_entries\|review_issues" src/
```

Fix any remaining references.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run linter**

Run: `npm run lint`
Expected: PASS (or fix any issues)

**Step 4: Run full test suite**

Run: `npm run test`
Expected: PASS (all 285+ tests)

**Step 5: Verify schema creates correctly**

Create a fresh test database and verify schema:
```bash
rm -rf /tmp/sq-test && mkdir /tmp/sq-test
npx tsx -e "import { createDatabase } from './src/db/index.js'; createDatabase('/tmp/sq-test/state.db'); console.log('Schema created successfully')"
```

**Step 6: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup for unified context implementation"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add unified context schema | `src/db/schema.sql` |
| 2 | Create context DB helpers | `src/db/context.ts`, `src/db/context.test.ts` |
| 3 | Add MCP tool schemas | `src/mcp/tools.ts`, `src/mcp/tools.test.ts` |
| 4 | Implement write_context tool | `src/mcp/server.ts`, `src/mcp/mcp.test.ts` |
| 5 | Implement read_context tool | `src/mcp/server.ts`, `src/mcp/mcp.test.ts` |
| 6 | Update loadState | `src/state/index.ts`, `src/state/index.test.ts` |
| 7 | Remove old MCP tools | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| 8 | Update agent prompts | `src/agents/prompts/*.ts` |
| 9 | Final cleanup | All files |

**Estimated commits:** 9
