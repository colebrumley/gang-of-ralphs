# Unified Context Storage Design

## Overview

Consolidate context storage from three locations (SQLite tables, scratchpad files, runs.codebase_analysis column) into a single unified `context` table with full-text search capability.

## Goals

- **Single source of truth**: One table for all context types
- **Simplified MCP surface**: 2 tools instead of 5+
- **Full-text search**: Agents can search context by keyword
- **Performance**: Indexed queries for all common access patterns

## Schema

### Unified context table

```sql
CREATE TABLE context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'discovery', 'error', 'decision', 'review_issue', 'scratchpad', 'codebase_analysis'
  content TEXT NOT NULL,           -- string or JSON string for structured types
  task_id TEXT,                    -- nullable, for task-scoped context
  loop_id TEXT,                    -- nullable, for loop-scoped context
  file TEXT,                       -- nullable, for file-specific context
  line INTEGER,                    -- nullable
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (run_id) REFERENCES runs(id)
);

-- Indexes for common query patterns
CREATE INDEX idx_context_run_id ON context(run_id);
CREATE INDEX idx_context_type ON context(run_id, type);
CREATE INDEX idx_context_task ON context(run_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_context_loop ON context(run_id, loop_id) WHERE loop_id IS NOT NULL;
CREATE INDEX idx_context_file ON context(run_id, file) WHERE file IS NOT NULL;
CREATE INDEX idx_context_created ON context(run_id, created_at DESC);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE context_fts USING fts5(
  content,
  content='context',
  content_rowid='id'
);

-- Keep FTS in sync
CREATE TRIGGER context_fts_insert AFTER INSERT ON context BEGIN
  INSERT INTO context_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER context_fts_delete AFTER DELETE ON context BEGIN
  INSERT INTO context_fts(context_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
```

### Tables/columns to remove

- `context_entries` table
- `review_issues` table
- `runs.codebase_analysis` column
- `.sq/scratchpads/` directory

## MCP Tools

### write_context

```typescript
{
  name: 'write_context',
  description: 'Write context to the shared context store.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['discovery', 'error', 'decision', 'review_issue', 'scratchpad', 'codebase_analysis'],
        description: 'The type of context being written'
      },
      content: {
        type: 'string',
        description: 'The content. Plain string for simple types, JSON string for structured types'
      },
      task_id: { type: 'string', description: 'Associated task ID (optional)' },
      loop_id: { type: 'string', description: 'Associated loop ID (optional)' },
      file: { type: 'string', description: 'Associated file path (optional)' },
      line: { type: 'integer', description: 'Associated line number (optional)' }
    },
    required: ['type', 'content']
  }
}
```

### read_context

```typescript
{
  name: 'read_context',
  description: 'Read context from the shared context store. Supports filtering and full-text search.',
  inputSchema: {
    type: 'object',
    properties: {
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by context types (optional)'
      },
      task_id: { type: 'string', description: 'Filter by task ID (optional)' },
      loop_id: { type: 'string', description: 'Filter by loop ID (optional)' },
      file: { type: 'string', description: 'Filter by file path (optional)' },
      search: { type: 'string', description: 'Full-text search query (optional)' },
      limit: { type: 'integer', description: 'Max entries to return (default: 500)' },
      offset: { type: 'integer', description: 'Skip first N entries (default: 0)' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort by created_at (default: desc)' }
    },
    required: []
  }
}
```

Note: `run_id` is injected by the MCP server from current run context.

### Tools being removed

- `add_context`
- `set_review_result`
- `set_loop_review_result`
- `set_codebase_analysis`
- `write_scratchpad`

## Content Structure by Type

### Simple string types

```typescript
// type: 'discovery'
content: "Found existing auth middleware in src/middleware/auth.ts"

// type: 'error'
content: "Cost limit exceeded for loop-1: $2.15 > $2.00"

// type: 'decision'
content: "Using JWT tokens instead of sessions for stateless API"
```

### Structured JSON types

```typescript
// type: 'review_issue'
content: JSON.stringify({
  issue_type: 'over-engineering' | 'missing-error-handling' | 'pattern-violation' | 'dead-code' | 'spec-intent-mismatch' | 'architecture-concern',
  description: "Function handles 5 edge cases not in spec",
  suggestion: "Remove handling for network timeouts - spec assumes reliable connection"
})
// file, line, task_id stored in columns

// type: 'scratchpad'
content: JSON.stringify({
  iteration: 3,
  done: false,
  test_status: 'failing',
  next_step: "Fix TypeError in parseConfig by adding null check",
  blockers: ["Unclear whether config.timeout is optional"],
  attempted: ["Added try-catch around parse call", "Checked for undefined config"]
})

// type: 'codebase_analysis'
content: JSON.stringify({
  project_type: "Node.js CLI tool",
  tech_stack: ["TypeScript", "SQLite", "Ink/React TUI"],
  directory_structure: "src/ with orchestrator/, agents/, mcp/, db/, tui/",
  existing_features: ["Task enumeration", "Parallel execution", "Git worktrees"],
  entry_points: ["bin/sq", "src/index.ts"],
  patterns: ["Phase state machine", "MCP tools for agent communication"],
  summary: "AI orchestration system for coordinating Claude Code agents"
})
```

## Query Implementation

### Core query builder

```typescript
// src/db/context.ts

interface ReadContextOptions {
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

export function readContextFromDb(db: Database, opts: ReadContextOptions) {
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

  let query: string;

  if (search) {
    // FTS5 join for full-text search
    query = `
      SELECT c.* FROM context c
      JOIN context_fts fts ON c.id = fts.rowid
      WHERE ${conditions.join(' AND ')}
        AND context_fts MATCH ?
      ORDER BY rank, c.created_at ${order.toUpperCase()}
      LIMIT ? OFFSET ?
    `;
    params.push(search, limit, offset);
  } else {
    query = `
      SELECT * FROM context c
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at ${order.toUpperCase()}
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);
  }

  const entries = db.prepare(query).all(...params);

  // Get total count for pagination
  const countQuery = search
    ? `SELECT COUNT(*) as total FROM context c JOIN context_fts fts ON c.id = fts.rowid WHERE ${conditions.join(' AND ')} AND context_fts MATCH ?`
    : `SELECT COUNT(*) as total FROM context c WHERE ${conditions.join(' AND ')}`;

  const countParams = search ? [...params.slice(0, -2), search] : params.slice(0, -2);
  const { total } = db.prepare(countQuery).get(...countParams) as { total: number };

  return { entries, total };
}

export function writeContextToDb(db: Database, entry: {
  runId: string;
  type: string;
  content: string;
  taskId?: string;
  loopId?: string;
  file?: string;
  line?: number;
}) {
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

  return { id: result.lastInsertRowid };
}
```

## loadState() Changes

```typescript
// src/state/index.ts

export async function loadState(db: Database, runId: string): Promise<OrchestratorState> {
  // ... existing task, loop, plan_group loading ...

  // Replace fragmented context loading with unified query
  const contextEntries = await readContextFromDb(db, {
    runId,
    limit: 2000,
    order: 'asc'
  });

  // Partition by type for the OrchestratorContext shape
  const context: OrchestratorContext = {
    discoveries: [],
    errors: [],
    decisions: [],
    reviewIssues: []
  };

  let codebaseAnalysis: CodebaseAnalysis | undefined;

  for (const entry of contextEntries) {
    switch (entry.type) {
      case 'discovery':
        context.discoveries.push(entry.content);
        break;
      case 'error':
        context.errors.push(entry.content);
        break;
      case 'decision':
        context.decisions.push(entry.content);
        break;
      case 'review_issue':
        context.reviewIssues.push({
          ...JSON.parse(entry.content),
          taskId: entry.task_id,
          file: entry.file,
          line: entry.line
        });
        break;
      case 'codebase_analysis':
        codebaseAnalysis = JSON.parse(entry.content);
        break;
      // scratchpad entries not loaded into OrchestratorContext
      // agents read them directly via read_context
    }
  }

  return { ...existingState, context, codebaseAnalysis };
}
```

## Pruning

```typescript
export async function pruneContext(db: Database, runId: string, maxPerType: number = 500) {
  const types = ['discovery', 'error', 'decision', 'review_issue', 'scratchpad'];

  for (const type of types) {
    db.run(`
      DELETE FROM context
      WHERE run_id = ? AND type = ? AND id NOT IN (
        SELECT id FROM context
        WHERE run_id = ? AND type = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
    `, [runId, type, runId, type, maxPerType]);
  }
  // codebase_analysis not pruned - only one per run
}
```

## Agent Prompt Updates

### System prompt section

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
- Your scratchpad history: `read_context({ types: ['scratchpad'], loop_id: '<your-loop-id>' })`
```

### Build agent iteration instructions

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

## Files to Change

| File | Changes |
|------|---------|
| `src/db/schema.sql` | Add `context` table, FTS5, triggers; remove `context_entries`, `review_issues` |
| `src/db/context.ts` | New file with `readContextFromDb`, `writeContextToDb`, `pruneContext` |
| `src/mcp/server.ts` | Replace 5 tools with `write_context`, `read_context` |
| `src/mcp/tools.ts` | Update tool schemas |
| `src/state/index.ts` | Simplify `loadState()` to use unified query; remove old loaders |
| `src/agents/prompts/*.ts` | Update agent prompts for new tools |
| Scratchpad file I/O | Delete all scratchpad file operations |

## Performance Characteristics

- **Indexed queries**: All common access patterns have dedicated indexes
- **FTS5**: Full-text search without table scans
- **Single query path**: All context reads go through `readContextFromDb`
- **Pruning**: Per-type caps prevent unbounded growth (500 per type default)
- **Partial indexes**: `WHERE IS NOT NULL` on optional columns reduces index size
