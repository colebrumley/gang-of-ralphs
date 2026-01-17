# c2 Orchestrator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a TypeScript CLI orchestrator that improves on Ralph Wiggum with parallel loops, effort-based review, and multi-column TUI.

**Architecture:** Stateless orchestrator runs inside outer Ralph loop. Reads state from disk, executes one phase, saves state, exits. Spawns Claude Code agents via SDK for actual work. Parallel loops for independent tasks.

**Tech Stack:** TypeScript, @anthropic-ai/claude-agent-sdk, commander (CLI), ink (TUI), zod (validation), better-sqlite3, @anthropic-ai/sdk (MCP)

---

## Risk Mitigations

This plan addresses the following high-priority risks:

| Risk | Mitigation | Task |
|------|------------|------|
| **JSON Parsing Fragility** | Eliminated - agents write to SQLite via MCP tools | Task 3, 3A |
| **Prompt Engineering Quality** | Prompt testing harness | Task 6A |
| **Cost Runaway** | Cost tracking + limits | Tasks 2, 5, 13 |
| **Task Granularity** | Validation in enumerate phase | Task 7 |
| **Stuck Detection Accuracy** | Configurable thresholds + logging | Task 10 |

---

## Architecture: SQLite + MCP

Instead of agents outputting JSON that we parse, agents write directly to SQLite via MCP tools:

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Agent                           │
│  (calls MCP tools instead of outputting JSON)               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ MCP Protocol
┌─────────────────────────────────────────────────────────────┐
│                    c2-mcp-server                            │
│  Tools: write_task, complete_task, add_plan_group, etc.     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  SQLite: .c2/state.db                       │
│  Tables: runs, tasks, loops, phases, costs                  │
└─────────────────────────────────────────────────────────────┘
```

**Benefits:**
- No JSON parsing errors - tool params are already structured
- Atomic transactions - no state corruption
- Queryable history - can analyze past runs
- Type-safe - MCP tool schemas enforce structure

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/index.ts`

**Step 1: Initialize npm project**

Run: `npm init -y`

**Step 2: Install dependencies**

Run:
```bash
npm install @anthropic-ai/claude-agent-sdk @modelcontextprotocol/sdk commander zod better-sqlite3
npm install -D typescript @types/node @types/better-sqlite3 tsx
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Update package.json**

Add to package.json:
```json
{
  "type": "module",
  "bin": {
    "c2": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "node --test"
  }
}
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
.c2/
*.log
```

**Step 6: Create minimal entry point**

Create `src/index.ts`:
```typescript
#!/usr/bin/env node
console.log("c2 orchestrator");
```

**Step 7: Verify setup**

Run: `npm run dev`
Expected: prints "c2 orchestrator"

**Step 8: Commit**

```bash
git add -A
git commit -m "chore: initialize project with TypeScript and dependencies"
```

---

## Task 2: Define Core Types

**Files:**
- Create: `src/types/index.ts`
- Create: `src/types/state.ts`
- Create: `src/types/task.ts`
- Create: `src/types/loop.ts`

**Step 1: Create types directory**

Run: `mkdir -p src/types`

**Step 2: Create task types**

Create `src/types/task.ts`:
```typescript
export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependencies: string[]; // Task IDs this depends on
  estimatedIterations: number;
  assignedLoopId: string | null;
}

export interface TaskGraph {
  tasks: Task[];
  parallelGroups: string[][]; // Groups of task IDs that can run in parallel
}
```

**Step 3: Create loop types**

Create `src/types/loop.ts`:
```typescript
export interface StuckIndicators {
  sameErrorCount: number;
  noProgressCount: number;
  lastError: string | null;
  lastFileChangeIteration: number;
}

export interface LoopState {
  loopId: string;
  taskIds: string[];
  iteration: number;
  maxIterations: number;
  reviewInterval: number;
  lastReviewAt: number;
  status: 'pending' | 'running' | 'stuck' | 'completed' | 'failed';
  stuckIndicators: StuckIndicators;
  output: string[]; // Recent output lines for TUI
}
```

**Step 4: Create state types**

Create `src/types/state.ts`:
```typescript
import type { Task, TaskGraph } from './task.js';
import type { LoopState } from './loop.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export type Phase = 'enumerate' | 'plan' | 'build' | 'review' | 'revise' | 'complete';
export type ReviewType = 'enumerate' | 'plan' | 'build' | null;

export interface PhaseResult {
  phase: Phase;
  success: boolean;
  timestamp: string;
  summary: string;
}

export interface OrchestratorContext {
  discoveries: string[];
  errors: string[];
  decisions: string[];
}

export interface CostTracking {
  totalCostUsd: number;
  phaseCosts: Record<Phase, number>;
  loopCosts: Record<string, number>; // loopId -> cost
}

export interface CostLimits {
  perLoopMaxUsd: number;
  perPhaseMaxUsd: number;
  perRunMaxUsd: number;
}

export interface OrchestratorState {
  // Identity
  runId: string;
  specPath: string;
  effort: EffortLevel;

  // Phase tracking
  phase: Phase;
  phaseHistory: PhaseResult[];

  // Task management
  tasks: Task[];
  taskGraph: TaskGraph | null;

  // Build tracking
  activeLoops: LoopState[];
  completedTasks: string[];

  // Review tracking
  pendingReview: boolean;
  reviewType: ReviewType;
  revisionCount: number;

  // Context for agents
  context: OrchestratorContext;

  // Cost tracking (Risk #3 mitigation)
  costs: CostTracking;
  costLimits: CostLimits;

  // Config
  maxLoops: number;
  maxIterations: number;
  stateDir: string;
}
```

**Step 5: Create barrel export**

Create `src/types/index.ts`:
```typescript
export * from './task.js';
export * from './loop.js';
export * from './state.js';
```

**Step 6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add core type definitions for state, tasks, and loops"
```

---

## Task 3: SQLite Database Setup

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/index.ts`
- Create: `src/db/migrations.ts`
- Test: `src/db/db.test.ts`

**Step 1: Create db directory**

Run: `mkdir -p src/db`

**Step 2: Create database schema**

Create `src/db/schema.sql`:
```sql
-- Runs table: one row per orchestrator invocation
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  spec_path TEXT NOT NULL,
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'max')),
  phase TEXT NOT NULL DEFAULT 'enumerate',
  pending_review INTEGER NOT NULL DEFAULT 0,
  review_type TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  max_loops INTEGER NOT NULL DEFAULT 4,
  max_iterations INTEGER NOT NULL DEFAULT 20,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks table: enumerated tasks for a run
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  dependencies TEXT NOT NULL DEFAULT '[]', -- JSON array of task IDs
  estimated_iterations INTEGER NOT NULL DEFAULT 10,
  assigned_loop_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plan groups: parallel execution groups
CREATE TABLE IF NOT EXISTS plan_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  group_index INTEGER NOT NULL,
  task_ids TEXT NOT NULL, -- JSON array of task IDs
  UNIQUE(run_id, group_index)
);

-- Loops table: parallel execution loops
CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_ids TEXT NOT NULL, -- JSON array
  iteration INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL,
  review_interval INTEGER NOT NULL,
  last_review_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'stuck', 'completed', 'failed')),
  same_error_count INTEGER NOT NULL DEFAULT 0,
  no_progress_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_file_change_iteration INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase history: log of completed phases
CREATE TABLE IF NOT EXISTS phase_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT NOT NULL,
  success INTEGER NOT NULL,
  summary TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Context: discoveries, errors, decisions
CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('discovery', 'error', 'decision')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_loops_run ON loops(run_id);
CREATE INDEX IF NOT EXISTS idx_phase_history_run ON phase_history(run_id);
```

**Step 3: Write failing test**

Create `src/db/db.test.ts`:
```typescript
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, closeDatabase } from './index.js';

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
```

**Step 4: Run test to verify it fails**

Run: `npm test -- src/db/db.test.ts`
Expected: FAIL - module not found

**Step 5: Implement database module**

Create `src/db/index.ts`:
```typescript
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function createDatabase(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  return db;
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call createDatabase first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Helper to get current run
export function getCurrentRun(runId: string) {
  return getDatabase().prepare('SELECT * FROM runs WHERE id = ?').get(runId);
}

// Helper to update run phase
export function updateRunPhase(runId: string, phase: string) {
  getDatabase().prepare(`
    UPDATE runs SET phase = ?, updated_at = datetime('now') WHERE id = ?
  `).run(phase, runId);
}

// Helper to get all tasks for a run
export function getTasksForRun(runId: string) {
  return getDatabase().prepare('SELECT * FROM tasks WHERE run_id = ?').all(runId);
}

// Helper to get active loops for a run
export function getActiveLoops(runId: string) {
  return getDatabase().prepare(`
    SELECT * FROM loops WHERE run_id = ? AND status IN ('pending', 'running')
  `).all(runId);
}
```

**Step 6: Run tests to verify they pass**

Run: `npm test -- src/db/db.test.ts`
Expected: All tests pass

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: implement SQLite database with schema for state storage"
```

---

## Task 3A: MCP Server for Agent→DB Communication

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/mcp/tools.ts`
- Create: `src/mcp/index.ts`
- Test: `src/mcp/mcp.test.ts`

**Step 1: Create MCP directory**

Run: `mkdir -p src/mcp`

**Step 2: Define MCP tools**

Create `src/mcp/tools.ts`:
```typescript
import { z } from 'zod';

// Tool schemas for MCP
export const WriteTaskSchema = z.object({
  id: z.string().describe('Unique task identifier'),
  title: z.string().describe('Short task title'),
  description: z.string().describe('Detailed task description'),
  dependencies: z.array(z.string()).default([]).describe('IDs of tasks this depends on'),
  estimatedIterations: z.number().default(10).describe('Estimated iterations to complete'),
});

export const CompleteTaskSchema = z.object({
  taskId: z.string().describe('ID of task to mark complete'),
});

export const FailTaskSchema = z.object({
  taskId: z.string().describe('ID of task that failed'),
  reason: z.string().describe('Why the task failed'),
});

export const AddPlanGroupSchema = z.object({
  groupIndex: z.number().describe('Order of this group (0 = first)'),
  taskIds: z.array(z.string()).describe('Task IDs that can run in parallel'),
});

export const UpdateLoopStatusSchema = z.object({
  loopId: z.string().describe('Loop ID'),
  status: z.enum(['running', 'stuck', 'completed', 'failed']).describe('New status'),
  error: z.string().optional().describe('Error message if failed/stuck'),
});

export const RecordCostSchema = z.object({
  costUsd: z.number().describe('Cost in USD'),
  loopId: z.string().optional().describe('Loop ID if loop-specific'),
});

export const AddContextSchema = z.object({
  type: z.enum(['discovery', 'error', 'decision']).describe('Type of context entry'),
  content: z.string().describe('The context content'),
});

export const SetReviewResultSchema = z.object({
  passed: z.boolean().describe('Whether review passed'),
  issues: z.array(z.string()).default([]).describe('Issues found'),
});

export type WriteTask = z.infer<typeof WriteTaskSchema>;
export type CompleteTask = z.infer<typeof CompleteTaskSchema>;
export type AddPlanGroup = z.infer<typeof AddPlanGroupSchema>;
```

**Step 3: Implement MCP server**

Create `src/mcp/server.ts`:
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getDatabase } from '../db/index.js';
import {
  WriteTaskSchema,
  CompleteTaskSchema,
  AddPlanGroupSchema,
  UpdateLoopStatusSchema,
  RecordCostSchema,
  AddContextSchema,
  SetReviewResultSchema,
} from './tools.js';

export function createMCPServer(runId: string) {
  const server = new Server(
    { name: 'c2-orchestrator', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'write_task',
        description: 'Create a new task for the current run',
        inputSchema: { type: 'object', properties: WriteTaskSchema.shape },
      },
      {
        name: 'complete_task',
        description: 'Mark a task as completed',
        inputSchema: { type: 'object', properties: CompleteTaskSchema.shape },
      },
      {
        name: 'add_plan_group',
        description: 'Add a parallel execution group to the plan',
        inputSchema: { type: 'object', properties: AddPlanGroupSchema.shape },
      },
      {
        name: 'update_loop_status',
        description: 'Update the status of an execution loop',
        inputSchema: { type: 'object', properties: UpdateLoopStatusSchema.shape },
      },
      {
        name: 'record_cost',
        description: 'Record API cost for the run',
        inputSchema: { type: 'object', properties: RecordCostSchema.shape },
      },
      {
        name: 'add_context',
        description: 'Add a discovery, error, or decision to context',
        inputSchema: { type: 'object', properties: AddContextSchema.shape },
      },
      {
        name: 'set_review_result',
        description: 'Record the result of a review phase',
        inputSchema: { type: 'object', properties: SetReviewResultSchema.shape },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const db = getDatabase();

    switch (name) {
      case 'write_task': {
        const task = WriteTaskSchema.parse(args);
        db.prepare(`
          INSERT INTO tasks (id, run_id, title, description, dependencies, estimated_iterations)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          task.id,
          runId,
          task.title,
          task.description,
          JSON.stringify(task.dependencies),
          task.estimatedIterations
        );
        return { content: [{ type: 'text', text: `Task ${task.id} created` }] };
      }

      case 'complete_task': {
        const { taskId } = CompleteTaskSchema.parse(args);
        db.prepare(`
          UPDATE tasks SET status = 'completed' WHERE id = ? AND run_id = ?
        `).run(taskId, runId);
        return { content: [{ type: 'text', text: `Task ${taskId} completed` }] };
      }

      case 'add_plan_group': {
        const group = AddPlanGroupSchema.parse(args);
        db.prepare(`
          INSERT INTO plan_groups (run_id, group_index, task_ids)
          VALUES (?, ?, ?)
        `).run(runId, group.groupIndex, JSON.stringify(group.taskIds));
        return { content: [{ type: 'text', text: `Plan group ${group.groupIndex} added` }] };
      }

      case 'update_loop_status': {
        const update = UpdateLoopStatusSchema.parse(args);
        db.prepare(`
          UPDATE loops SET status = ?, last_error = ? WHERE id = ?
        `).run(update.status, update.error || null, update.loopId);
        return { content: [{ type: 'text', text: `Loop ${update.loopId} updated` }] };
      }

      case 'record_cost': {
        const { costUsd, loopId } = RecordCostSchema.parse(args);
        if (loopId) {
          db.prepare(`
            UPDATE loops SET cost_usd = cost_usd + ? WHERE id = ?
          `).run(costUsd, loopId);
        }
        db.prepare(`
          UPDATE runs SET total_cost_usd = total_cost_usd + ? WHERE id = ?
        `).run(costUsd, runId);
        return { content: [{ type: 'text', text: `Cost $${costUsd} recorded` }] };
      }

      case 'add_context': {
        const ctx = AddContextSchema.parse(args);
        db.prepare(`
          INSERT INTO context_entries (run_id, entry_type, content)
          VALUES (?, ?, ?)
        `).run(runId, ctx.type, ctx.content);
        return { content: [{ type: 'text', text: `Context ${ctx.type} added` }] };
      }

      case 'set_review_result': {
        const review = SetReviewResultSchema.parse(args);
        // Store issues as context entries
        for (const issue of review.issues) {
          db.prepare(`
            INSERT INTO context_entries (run_id, entry_type, content)
            VALUES (?, 'error', ?)
          `).run(runId, issue);
        }
        return { content: [{ type: 'text', text: `Review result: ${review.passed ? 'PASSED' : 'FAILED'}` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

export async function startMCPServer(runId: string) {
  const server = createMCPServer(runId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

**Step 4: Create MCP entry point**

Create `src/mcp/index.ts`:
```typescript
#!/usr/bin/env node
import { createDatabase } from '../db/index.js';
import { startMCPServer } from './server.js';

// MCP server is started with run ID as argument
const runId = process.argv[2];
const dbPath = process.argv[3] || '.c2/state.db';

if (!runId) {
  console.error('Usage: c2-mcp <run-id> [db-path]');
  process.exit(1);
}

createDatabase(dbPath);
startMCPServer(runId).catch(console.error);
```

**Step 5: Write test**

Create `src/mcp/mcp.test.ts`:
```typescript
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, closeDatabase, getDatabase } from '../db/index.js';
import { createMCPServer } from './server.js';

describe('MCP Server', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'c2-mcp-test-'));
    createDatabase(join(tempDir, 'state.db'));

    // Create a test run
    getDatabase().prepare(`
      INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)
    `).run('test-run', '/spec.md', 'medium');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true });
  });

  test('write_task creates task in database', async () => {
    const server = createMCPServer('test-run');

    // Simulate tool call (in real usage, MCP SDK handles this)
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
});
```

**Step 6: Add bin entry for MCP server**

Update package.json:
```json
{
  "bin": {
    "c2": "./dist/index.js",
    "c2-mcp": "./dist/mcp/index.js"
  }
}
```

**Step 7: Run tests**

Run: `npm test -- src/mcp/mcp.test.ts`
Expected: All tests pass

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: implement MCP server for agent-to-database communication"
```

---

## Task 4: CLI Entry Point

**Files:**
- Modify: `src/index.ts`
- Create: `src/cli.ts`
- Test: `src/cli.test.ts`

**Step 1: Write failing test for CLI parsing**

Create `src/cli.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from './cli.js';

describe('CLI Argument Parsing', () => {
  test('parses required --spec argument', () => {
    const result = parseArgs(['--spec', 'spec.md']);
    assert.strictEqual(result.spec, 'spec.md');
  });

  test('parses --effort with default medium', () => {
    const result = parseArgs(['--spec', 'spec.md']);
    assert.strictEqual(result.effort, 'medium');
  });

  test('parses all options', () => {
    const result = parseArgs([
      '--spec', 'feature.md',
      '--effort', 'high',
      '--max-loops', '8',
      '--max-iterations', '30',
      '--state-dir', '.custom',
      '--reset'
    ]);

    assert.strictEqual(result.spec, 'feature.md');
    assert.strictEqual(result.effort, 'high');
    assert.strictEqual(result.maxLoops, 8);
    assert.strictEqual(result.maxIterations, 30);
    assert.strictEqual(result.stateDir, '.custom');
    assert.strictEqual(result.reset, true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/cli.test.ts`
Expected: FAIL - module not found

**Step 3: Implement CLI parser**

Create `src/cli.ts`:
```typescript
import { Command } from 'commander';
import type { EffortLevel } from './types/index.js';

export interface CLIOptions {
  spec: string;
  effort: EffortLevel;
  maxLoops: number;
  maxIterations: number;
  stateDir: string;
  resume: boolean;
  reset: boolean;
  dryRun: boolean;
}

export function parseArgs(args: string[]): CLIOptions {
  const program = new Command();

  program
    .name('c2')
    .description('AI orchestrator with parallel Ralph Wiggum loops')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--effort <level>', 'Effort level: low|medium|high|max', 'medium')
    .option('--max-loops <n>', 'Max concurrent parallel loops', '4')
    .option('--max-iterations <n>', 'Max iterations per loop', '20')
    .option('--state-dir <path>', 'State directory', '.c2')
    .option('--resume', 'Resume existing run', false)
    .option('--reset', 'Discard state and start fresh', false)
    .option('--dry-run', 'Show what would happen', false);

  program.parse(['node', 'c2', ...args]);
  const opts = program.opts();

  return {
    spec: opts.spec,
    effort: opts.effort as EffortLevel,
    maxLoops: parseInt(opts.maxLoops, 10),
    maxIterations: parseInt(opts.maxIterations, 10),
    stateDir: opts.stateDir,
    resume: opts.resume,
    reset: opts.reset,
    dryRun: opts.dryRun,
  };
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name('c2')
    .description('AI orchestrator with parallel Ralph Wiggum loops')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--effort <level>', 'Effort level: low|medium|high|max', 'medium')
    .option('--max-loops <n>', 'Max concurrent parallel loops', '4')
    .option('--max-iterations <n>', 'Max iterations per loop', '20')
    .option('--state-dir <path>', 'State directory', '.c2')
    .option('--resume', 'Resume existing run', false)
    .option('--reset', 'Discard state and start fresh', false)
    .option('--dry-run', 'Show what would happen', false);

  return program;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/cli.test.ts`
Expected: All tests pass

**Step 5: Update main entry point**

Update `src/index.ts`:
```typescript
#!/usr/bin/env node
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createCLI } from './cli.js';
import { loadState, saveState, initializeState } from './state/index.js';

async function main() {
  const program = createCLI();
  program.parse();
  const opts = program.opts();

  // Validate spec file exists
  const specPath = resolve(opts.spec);
  try {
    await access(specPath);
  } catch {
    console.error(`Error: Spec file not found: ${specPath}`);
    process.exit(1);
  }

  const stateDir = resolve(opts.stateDir);

  // Load or initialize state
  let state = opts.reset ? null : await loadState(stateDir);

  if (!state) {
    state = initializeState({
      specPath,
      effort: opts.effort,
      stateDir,
      maxLoops: parseInt(opts.maxLoops, 10),
      maxIterations: parseInt(opts.maxIterations, 10),
    });
    console.log(`Initialized new run: ${state.runId}`);
  } else {
    console.log(`Resuming run: ${state.runId}`);
  }

  console.log(`Phase: ${state.phase}`);
  console.log(`Effort: ${state.effort}`);

  if (opts.dryRun) {
    console.log('[dry-run] Would execute phase:', state.phase);
    return;
  }

  // TODO: Execute phase
  console.log('Phase execution not yet implemented');

  await saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Step 6: Create a test spec file**

Create `examples/test-spec.md`:
```markdown
# Test Feature Spec

Build a simple hello world function.

## Requirements

1. Create a function `greet(name: string)` that returns "Hello, {name}!"
2. Handle empty string by returning "Hello, World!"
3. Add tests for both cases
```

**Step 7: Verify CLI works**

Run: `npm run dev -- --spec examples/test-spec.md --dry-run`
Expected: Shows initialized run and phase info

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: implement CLI with commander and argument parsing"
```

---

## Task 5: Effort Configuration

**Files:**
- Create: `src/config/effort.ts`
- Test: `src/config/effort.test.ts`

**Step 1: Create config directory**

Run: `mkdir -p src/config`

**Step 2: Write failing test**

Create `src/config/effort.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { getEffortConfig } from './effort.js';

describe('Effort Configuration', () => {
  test('low effort has no intermediate reviews', () => {
    const config = getEffortConfig('low');
    assert.strictEqual(config.reviewAfterEnumerate, false);
    assert.strictEqual(config.reviewAfterPlan, false);
    assert.strictEqual(config.reviewInterval, 10);
  });

  test('medium effort reviews after plan', () => {
    const config = getEffortConfig('medium');
    assert.strictEqual(config.reviewAfterEnumerate, false);
    assert.strictEqual(config.reviewAfterPlan, true);
    assert.strictEqual(config.reviewInterval, 5);
  });

  test('high effort reviews after enumerate and plan', () => {
    const config = getEffortConfig('high');
    assert.strictEqual(config.reviewAfterEnumerate, true);
    assert.strictEqual(config.reviewAfterPlan, true);
    assert.strictEqual(config.reviewInterval, 3);
  });

  test('max effort reviews everything', () => {
    const config = getEffortConfig('max');
    assert.strictEqual(config.reviewAfterEnumerate, true);
    assert.strictEqual(config.reviewAfterPlan, true);
    assert.strictEqual(config.reviewInterval, 1);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test -- src/config/effort.test.ts`
Expected: FAIL - module not found

**Step 4: Implement effort config**

Create `src/config/effort.ts`:
```typescript
import type { EffortLevel } from '../types/index.js';

export interface EffortConfig {
  reviewAfterEnumerate: boolean;
  reviewAfterPlan: boolean;
  reviewInterval: number; // Review every N iterations in build loops
  reviewDepth: 'shallow' | 'standard' | 'deep' | 'comprehensive';
  stuckThreshold: number; // Same error count before flagging stuck

  // Cost limits (Risk #3 mitigation)
  costLimits: {
    perLoopMaxUsd: number;
    perPhaseMaxUsd: number;
    perRunMaxUsd: number;
  };
}

const EFFORT_CONFIGS: Record<EffortLevel, EffortConfig> = {
  low: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: false,
    reviewInterval: 10,
    reviewDepth: 'shallow',
    stuckThreshold: 5,
    costLimits: { perLoopMaxUsd: 1.0, perPhaseMaxUsd: 2.0, perRunMaxUsd: 5.0 },
  },
  medium: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: true,
    reviewInterval: 5,
    reviewDepth: 'standard',
    stuckThreshold: 4,
    costLimits: { perLoopMaxUsd: 2.0, perPhaseMaxUsd: 5.0, perRunMaxUsd: 15.0 },
  },
  high: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 3,
    reviewDepth: 'deep',
    stuckThreshold: 3,
    costLimits: { perLoopMaxUsd: 5.0, perPhaseMaxUsd: 10.0, perRunMaxUsd: 30.0 },
  },
  max: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 1,
    reviewDepth: 'comprehensive',
    stuckThreshold: 2,
    costLimits: { perLoopMaxUsd: 10.0, perPhaseMaxUsd: 25.0, perRunMaxUsd: 100.0 },
  },
};

export function getEffortConfig(effort: EffortLevel): EffortConfig {
  return EFFORT_CONFIGS[effort];
}
```

**Step 5: Run tests to verify they pass**

Run: `npm test -- src/config/effort.test.ts`
Expected: All tests pass

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add effort level configuration"
```

---

## Task 6: Agent Spawning

**Files:**
- Create: `src/agents/spawn.ts`
- Create: `src/agents/prompts.ts`
- Test: `src/agents/spawn.test.ts`

**Step 1: Create agents directory**

Run: `mkdir -p src/agents`

**Step 2: Create prompts file**

Create `src/agents/prompts.ts`:
```typescript
// Prompts instruct agents to use MCP tools instead of outputting JSON.
// The c2-mcp server provides tools for writing directly to SQLite.

export const ENUMERATE_PROMPT = `You are a task enumerator. Given a spec file, break it down into discrete, implementable tasks.

Read the spec file and create tasks using the write_task tool.

For each task, call write_task with:
- id: Unique identifier like "task-1", "task-2"
- title: Short descriptive title
- description: Detailed description of what needs to be done
- dependencies: Array of task IDs this depends on
- estimatedIterations: Estimated iterations to complete (5-20)

Rules:
- Each task should be completable in 5-20 iterations
- Identify dependencies between tasks
- Create tasks in order so dependencies come first
- Be specific about what files/functions to create or modify

When done creating all tasks, say "ENUMERATE_COMPLETE".`;

export const PLAN_PROMPT = `You are a task planner. Review the tasks in the database and create an execution plan.

Use the add_plan_group tool to define parallel execution groups.

For each group, call add_plan_group with:
- groupIndex: Order of execution (0 = first group, 1 = second, etc.)
- taskIds: Array of task IDs that can run in parallel

Rules:
- Group 0 should contain tasks with no dependencies
- Later groups contain tasks whose dependencies are in earlier groups
- Tasks in the same group run in parallel
- Minimize total execution time

When done, say "PLAN_COMPLETE".`;

export const BUILD_PROMPT = `You are a code builder. Implement the assigned task.

Follow TDD:
1. Write a failing test
2. Implement minimal code to pass
3. Refactor if needed
4. Run tests to verify

Use these tools as you work:
- add_context(type: "discovery", content: "...") - Record things you learn
- add_context(type: "decision", content: "...") - Record implementation decisions
- add_context(type: "error", content: "...") - Record errors encountered

When complete, call complete_task(taskId: "<your-task-id>").
If stuck, call update_loop_status(loopId: "<your-loop-id>", status: "stuck", error: "<reason>").`;

export const REVIEW_PROMPT = `You are a code reviewer. Evaluate the work done so far.

Check:
1. Does the implementation match the spec?
2. Are there any bugs or edge cases missed?
3. Do all tests pass?
4. Is the code quality acceptable?

Record your findings using:
- add_context(type: "error", content: "...") for each issue found
- add_context(type: "discovery", content: "...") for observations

When done, call set_review_result with:
- passed: true/false
- issues: Array of issue descriptions (if any)`;
```

**Step 3: Write failing test for spawn**

Create `src/agents/spawn.test.ts`:
```typescript
import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import { createAgentConfig } from './spawn.js';

describe('Agent Spawning', () => {
  test('createAgentConfig returns valid config for enumerate phase', () => {
    const config = createAgentConfig('enumerate', '/path/to/project');

    assert.strictEqual(config.cwd, '/path/to/project');
    assert.ok(config.allowedTools.includes('Read'));
    assert.ok(config.allowedTools.includes('Glob'));
    assert.strictEqual(config.permissionMode, 'bypassPermissions');
  });

  test('createAgentConfig for build includes Edit and Bash', () => {
    const config = createAgentConfig('build', '/path/to/project');

    assert.ok(config.allowedTools.includes('Edit'));
    assert.ok(config.allowedTools.includes('Bash'));
  });
});
```

**Step 4: Run test to verify it fails**

Run: `npm test -- src/agents/spawn.test.ts`
Expected: FAIL - module not found

**Step 5: Implement spawn module**

Create `src/agents/spawn.ts`:
```typescript
import { resolve } from 'node:path';
import type { Phase } from '../types/index.js';

export interface AgentConfig {
  cwd: string;
  allowedTools: string[];
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  maxTurns: number;
  systemPrompt?: string;
  mcpServers?: Record<string, { command: string; args: string[] }>;
}

const PHASE_TOOLS: Record<Phase, string[]> = {
  enumerate: ['Read', 'Glob', 'Grep'],
  plan: ['Read', 'Glob', 'Grep'],
  build: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  review: ['Read', 'Glob', 'Grep', 'Bash'],
  revise: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  complete: [],
};

const PHASE_MAX_TURNS: Record<Phase, number> = {
  enumerate: 50,
  plan: 30,
  build: 100,
  review: 50,
  revise: 100,
  complete: 1,
};

/**
 * Create agent config with MCP server for database access.
 * The MCP server provides tools like write_task, complete_task, etc.
 */
export function createAgentConfig(
  phase: Phase,
  cwd: string,
  runId?: string,
  dbPath?: string
): AgentConfig {
  const config: AgentConfig = {
    cwd,
    allowedTools: PHASE_TOOLS[phase],
    permissionMode: 'bypassPermissions',
    maxTurns: PHASE_MAX_TURNS[phase],
  };

  // Add MCP server for phases that write to the database
  if (runId && ['enumerate', 'plan', 'build', 'review', 'revise'].includes(phase)) {
    config.mcpServers = {
      'c2-db': {
        command: 'node',
        args: [
          resolve(cwd, 'node_modules/.bin/c2-mcp'),
          runId,
          dbPath || resolve(cwd, '.c2/state.db'),
        ],
      },
    };
  }

  return config;
}

export interface AgentMessage {
  type: 'assistant' | 'result' | 'tool';
  content?: string;
  toolName?: string;
}

export type AgentOutputHandler = (message: AgentMessage) => void;
```

**Step 6: Run tests to verify they pass**

Run: `npm test -- src/agents/spawn.test.ts`
Expected: All tests pass

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add agent configuration and prompts"
```

---

## Task 6A: Prompt Testing Harness (Risk #1 Mitigation)

**Files:**
- Create: `src/testing/prompt-harness.ts`
- Create: `scripts/test-prompts.ts`

**Purpose:** Before relying on prompts in production, validate they produce consistent, parseable output.

**Step 1: Create testing directory**

Run: `mkdir -p src/testing scripts`

**Step 2: Create prompt testing harness**

Create `src/testing/prompt-harness.ts`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { extractJSON, JSONExtractionError } from '../utils/json-parser.js';

export interface PromptTestResult {
  promptName: string;
  runs: number;
  successRate: number;
  avgCostUsd: number;
  failures: Array<{
    run: number;
    error: string;
    rawOutput: string;
  }>;
  samples: Array<{
    run: number;
    output: unknown;
    costUsd: number;
  }>;
}

export interface PromptTestConfig {
  prompt: string;
  requiredKeys: string[];
  runs: number;
  allowedTools?: string[];
  maxTurns?: number;
}

/**
 * Run a prompt multiple times and measure success rate.
 * Use this to validate prompts before deploying.
 */
export async function testPrompt(
  name: string,
  config: PromptTestConfig
): Promise<PromptTestResult> {
  const result: PromptTestResult = {
    promptName: name,
    runs: config.runs,
    successRate: 0,
    avgCostUsd: 0,
    failures: [],
    samples: [],
  };

  let successCount = 0;
  let totalCost = 0;

  for (let run = 1; run <= config.runs; run++) {
    let fullOutput = '';
    let costUsd = 0;

    try {
      for await (const message of query({
        prompt: config.prompt,
        options: {
          allowedTools: config.allowedTools || ['Read', 'Glob'],
          permissionMode: 'bypassPermissions',
          maxTurns: config.maxTurns || 10,
        },
      })) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block) {
              fullOutput += block.text;
            }
          }
        }
        if (message.type === 'result') {
          costUsd = message.total_cost_usd || 0;
        }
      }

      // Try to extract JSON
      const parsed = extractJSON(fullOutput, config.requiredKeys);
      successCount++;
      totalCost += costUsd;

      result.samples.push({
        run,
        output: parsed,
        costUsd,
      });
    } catch (error) {
      result.failures.push({
        run,
        error: error instanceof Error ? error.message : String(error),
        rawOutput: fullOutput.slice(0, 500),
      });
    }
  }

  result.successRate = successCount / config.runs;
  result.avgCostUsd = totalCost / Math.max(successCount, 1);

  return result;
}

export function printTestReport(result: PromptTestResult): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Prompt: ${result.promptName}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Runs: ${result.runs}`);
  console.log(`Success Rate: ${(result.successRate * 100).toFixed(1)}%`);
  console.log(`Avg Cost: $${result.avgCostUsd.toFixed(4)}`);

  if (result.failures.length > 0) {
    console.log(`\nFailures (${result.failures.length}):`);
    for (const f of result.failures.slice(0, 3)) {
      console.log(`  Run ${f.run}: ${f.error}`);
    }
  }

  if (result.samples.length > 0) {
    console.log(`\nSample output (run ${result.samples[0].run}):`);
    console.log(JSON.stringify(result.samples[0].output, null, 2).slice(0, 500));
  }
}
```

**Step 3: Create test script**

Create `scripts/test-prompts.ts`:
```typescript
#!/usr/bin/env tsx
import { testPrompt, printTestReport } from '../src/testing/prompt-harness.js';
import { ENUMERATE_PROMPT, PLAN_PROMPT, REVIEW_PROMPT } from '../src/agents/prompts.js';

const TEST_SPEC = `
# Test Feature
Create a greeting function.
## Requirements
1. greet(name) returns "Hello, {name}!"
2. Handle empty name
`;

async function main() {
  console.log('Testing prompts against sample spec...\n');

  // Test enumerate prompt
  const enumerateResult = await testPrompt('enumerate', {
    prompt: `${ENUMERATE_PROMPT}\n\n## Spec:\n${TEST_SPEC}`,
    requiredKeys: ['tasks'],
    runs: 3,
  });
  printTestReport(enumerateResult);

  // Test plan prompt (with sample tasks)
  const sampleTasks = [
    { id: 't1', title: 'Create greet function', dependencies: [] },
    { id: 't2', title: 'Add tests', dependencies: ['t1'] },
  ];
  const planResult = await testPrompt('plan', {
    prompt: `${PLAN_PROMPT}\n\n## Tasks:\n${JSON.stringify(sampleTasks)}`,
    requiredKeys: ['parallelGroups'],
    runs: 3,
  });
  printTestReport(planResult);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const allResults = [enumerateResult, planResult];
  const avgSuccess = allResults.reduce((a, r) => a + r.successRate, 0) / allResults.length;
  console.log(`Overall Success Rate: ${(avgSuccess * 100).toFixed(1)}%`);

  if (avgSuccess < 0.9) {
    console.log('\n⚠️  WARNING: Prompts need improvement before production use.');
    process.exit(1);
  } else {
    console.log('\n✓ Prompts are ready for use.');
  }
}

main().catch(console.error);
```

**Step 4: Add script to package.json**

Add to scripts:
```json
{
  "test:prompts": "tsx scripts/test-prompts.ts"
}
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add prompt testing harness for validation before deployment"
```

---

## Task 7: Enumerate Phase

**Files:**
- Create: `src/orchestrator/phases/enumerate.ts`
- Test: `src/orchestrator/phases/enumerate.test.ts`

**Step 1: Create phases directory**

Run: `mkdir -p src/orchestrator/phases`

**Step 2: Write failing test**

Create `src/orchestrator/phases/enumerate.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseEnumerateOutput, validateTaskGranularity } from './enumerate.js';

describe('Enumerate Phase', () => {
  test('parseEnumerateOutput extracts tasks from JSON', () => {
    const output = `Some thinking...
\`\`\`json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Create greet function",
      "description": "Implement greet(name) function",
      "dependencies": [],
      "estimatedIterations": 5
    }
  ]
}
\`\`\`
Done!`;

    const tasks = parseEnumerateOutput(output);

    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, 'task-1');
    assert.strictEqual(tasks[0].title, 'Create greet function');
  });

  test('parseEnumerateOutput handles invalid JSON gracefully', () => {
    const output = 'No JSON here';

    assert.throws(() => parseEnumerateOutput(output), /No valid JSON/);
  });

  // Risk #5 mitigation: Task granularity validation
  test('validateTaskGranularity warns on too-large tasks', () => {
    const tasks = [
      { id: 't1', title: 'Huge task', description: 'Everything',
        status: 'pending' as const, dependencies: [], estimatedIterations: 50, assignedLoopId: null }
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some(w => w.includes('too large')));
  });

  test('validateTaskGranularity warns on too-small tasks', () => {
    const tasks = [
      { id: 't1', title: 'Tiny', description: 'x',
        status: 'pending' as const, dependencies: [], estimatedIterations: 1, assignedLoopId: null }
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some(w => w.includes('too small')));
  });

  test('validateTaskGranularity passes for well-sized tasks', () => {
    const tasks = [
      { id: 't1', title: 'Good task', description: 'Reasonable scope',
        status: 'pending' as const, dependencies: [], estimatedIterations: 10, assignedLoopId: null }
    ];
    const result = validateTaskGranularity(tasks);
    assert.strictEqual(result.warnings.length, 0);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test -- src/orchestrator/phases/enumerate.test.ts`
Expected: FAIL - module not found

**Step 4: Implement enumerate phase**

Create `src/orchestrator/phases/enumerate.ts`:
```typescript
import { readFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, Task } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { ENUMERATE_PROMPT } from '../../agents/prompts.js';
import { extractJSON } from '../../utils/json-parser.js';

// Task granularity bounds (Risk #5 mitigation)
const MIN_ESTIMATED_ITERATIONS = 3;
const MAX_ESTIMATED_ITERATIONS = 25;

export interface GranularityValidation {
  valid: boolean;
  warnings: string[];
}

/**
 * Validate that tasks are appropriately sized.
 * Too small = overhead dominates, too large = never completes.
 */
export function validateTaskGranularity(tasks: Task[]): GranularityValidation {
  const warnings: string[] = [];

  for (const task of tasks) {
    if (task.estimatedIterations < MIN_ESTIMATED_ITERATIONS) {
      warnings.push(
        `Task "${task.title}" (${task.id}) may be too small ` +
        `(${task.estimatedIterations} iterations). Consider combining with related tasks.`
      );
    }
    if (task.estimatedIterations > MAX_ESTIMATED_ITERATIONS) {
      warnings.push(
        `Task "${task.title}" (${task.id}) may be too large ` +
        `(${task.estimatedIterations} iterations). Consider breaking into subtasks.`
      );
    }
    if (task.description.length < 20) {
      warnings.push(
        `Task "${task.title}" (${task.id}) has a short description. ` +
        `More detail helps the build agent.`
      );
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

export function parseEnumerateOutput(output: string): Task[] {
  // Use robust JSON parser (Risk #2 mitigation)
  const parsed = extractJSON<{ tasks: any[] }>(output, ['tasks']);

  return parsed.tasks.map((t: any) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: 'pending' as const,
    dependencies: t.dependencies || [],
    estimatedIterations: t.estimatedIterations || 10,
    assignedLoopId: null,
  }));
}

export async function executeEnumerate(
  state: OrchestratorState,
  onOutput?: (text: string) => void
): Promise<Task[]> {
  const specContent = await readFile(state.specPath, 'utf-8');
  const config = createAgentConfig('enumerate', process.cwd());

  const prompt = `${ENUMERATE_PROMPT}

## Spec File Content:
${specContent}`;

  let fullOutput = '';

  for await (const message of query({
    prompt,
    options: {
      allowedTools: config.allowedTools,
      permissionMode: config.permissionMode,
      maxTurns: config.maxTurns,
    },
  })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block) {
          fullOutput += block.text;
          onOutput?.(block.text);
        }
      }
    }
  }

  return parseEnumerateOutput(fullOutput);
}
```

**Step 5: Run tests to verify they pass**

Run: `npm test -- src/orchestrator/phases/enumerate.test.ts`
Expected: All tests pass

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: implement enumerate phase with task extraction"
```

---

## Task 8: Plan Phase

**Files:**
- Create: `src/orchestrator/phases/plan.ts`
- Test: `src/orchestrator/phases/plan.test.ts`

**Step 1: Write failing test**

Create `src/orchestrator/phases/plan.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parsePlanOutput, buildTaskGraph } from './plan.js';

describe('Plan Phase', () => {
  test('parsePlanOutput extracts parallel groups', () => {
    const output = `\`\`\`json
{
  "parallelGroups": [
    ["task-1", "task-2"],
    ["task-3"]
  ],
  "reasoning": "Tasks 1 and 2 have no dependencies"
}
\`\`\``;

    const result = parsePlanOutput(output);

    assert.deepStrictEqual(result.parallelGroups, [
      ['task-1', 'task-2'],
      ['task-3']
    ]);
  });

  test('buildTaskGraph creates valid graph from tasks and groups', () => {
    const tasks = [
      { id: 'task-1', title: 'A', description: '', status: 'pending' as const, dependencies: [], estimatedIterations: 5, assignedLoopId: null },
      { id: 'task-2', title: 'B', description: '', status: 'pending' as const, dependencies: [], estimatedIterations: 5, assignedLoopId: null },
    ];
    const parallelGroups = [['task-1', 'task-2']];

    const graph = buildTaskGraph(tasks, parallelGroups);

    assert.strictEqual(graph.tasks.length, 2);
    assert.deepStrictEqual(graph.parallelGroups, parallelGroups);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/orchestrator/phases/plan.test.ts`
Expected: FAIL - module not found

**Step 3: Implement plan phase**

Create `src/orchestrator/phases/plan.ts`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, Task, TaskGraph } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { PLAN_PROMPT } from '../../agents/prompts.js';

export interface PlanOutput {
  parallelGroups: string[][];
  reasoning: string;
}

export function parsePlanOutput(output: string): PlanOutput {
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    output.match(/(\{[\s\S]*"parallelGroups"[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error('Failed to parse: No JSON found in output');
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    return {
      parallelGroups: parsed.parallelGroups,
      reasoning: parsed.reasoning || '',
    };
  } catch (e) {
    throw new Error(`Failed to parse: ${e}`);
  }
}

export function buildTaskGraph(tasks: Task[], parallelGroups: string[][]): TaskGraph {
  return {
    tasks,
    parallelGroups,
  };
}

export async function executePlan(
  state: OrchestratorState,
  onOutput?: (text: string) => void
): Promise<TaskGraph> {
  const config = createAgentConfig('plan', process.cwd());

  const tasksJson = JSON.stringify(state.tasks, null, 2);
  const prompt = `${PLAN_PROMPT}

## Tasks to Plan:
${tasksJson}`;

  let fullOutput = '';

  for await (const message of query({
    prompt,
    options: {
      allowedTools: config.allowedTools,
      permissionMode: config.permissionMode,
      maxTurns: config.maxTurns,
    },
  })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block) {
          fullOutput += block.text;
          onOutput?.(block.text);
        }
      }
    }
  }

  const planOutput = parsePlanOutput(fullOutput);
  return buildTaskGraph(state.tasks, planOutput.parallelGroups);
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/orchestrator/phases/plan.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement plan phase with parallel group extraction"
```

---

## Task 9: Loop Manager

**Files:**
- Create: `src/loops/manager.ts`
- Create: `src/loops/loop.ts`
- Test: `src/loops/manager.test.ts`

**Step 1: Create loops directory**

Run: `mkdir -p src/loops`

**Step 2: Write failing test**

Create `src/loops/manager.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LoopManager } from './manager.js';
import type { Task, LoopState } from '../types/index.js';

describe('Loop Manager', () => {
  test('createLoop initializes loop with correct state', () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });
    const tasks: Task[] = [
      { id: 't1', title: 'Task 1', description: '', status: 'pending', dependencies: [], estimatedIterations: 5, assignedLoopId: null }
    ];

    const loop = manager.createLoop(['t1'], tasks);

    assert.ok(loop.loopId);
    assert.deepStrictEqual(loop.taskIds, ['t1']);
    assert.strictEqual(loop.status, 'pending');
    assert.strictEqual(loop.iteration, 0);
  });

  test('canSpawnMore respects maxLoops', () => {
    const manager = new LoopManager({ maxLoops: 2, maxIterations: 20, reviewInterval: 5 });

    assert.strictEqual(manager.canSpawnMore(), true);
    manager.createLoop(['t1'], []);
    assert.strictEqual(manager.canSpawnMore(), true);
    manager.createLoop(['t2'], []);
    assert.strictEqual(manager.canSpawnMore(), false);
  });

  test('getActiveLoops returns only running loops', () => {
    const manager = new LoopManager({ maxLoops: 4, maxIterations: 20, reviewInterval: 5 });

    const loop1 = manager.createLoop(['t1'], []);
    const loop2 = manager.createLoop(['t2'], []);

    manager.updateLoopStatus(loop1.loopId, 'running');
    manager.updateLoopStatus(loop2.loopId, 'completed');

    const active = manager.getActiveLoops();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].loopId, loop1.loopId);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test -- src/loops/manager.test.ts`
Expected: FAIL - module not found

**Step 4: Implement loop manager**

Create `src/loops/manager.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import type { Task, LoopState } from '../types/index.js';

export interface LoopManagerConfig {
  maxLoops: number;
  maxIterations: number;
  reviewInterval: number;
}

export class LoopManager {
  private loops: Map<string, LoopState> = new Map();
  private config: LoopManagerConfig;

  constructor(config: LoopManagerConfig) {
    this.config = config;
  }

  createLoop(taskIds: string[], tasks: Task[]): LoopState {
    const loopId = randomUUID();
    const loop: LoopState = {
      loopId,
      taskIds,
      iteration: 0,
      maxIterations: this.config.maxIterations,
      reviewInterval: this.config.reviewInterval,
      lastReviewAt: 0,
      status: 'pending',
      stuckIndicators: {
        sameErrorCount: 0,
        noProgressCount: 0,
        lastError: null,
        lastFileChangeIteration: 0,
      },
      output: [],
    };

    this.loops.set(loopId, loop);

    // Update task assignments
    for (const task of tasks) {
      if (taskIds.includes(task.id)) {
        task.assignedLoopId = loopId;
      }
    }

    return loop;
  }

  canSpawnMore(): boolean {
    const activeCount = this.getActiveLoops().length +
                        this.getPendingLoops().length;
    return activeCount < this.config.maxLoops;
  }

  getLoop(loopId: string): LoopState | undefined {
    return this.loops.get(loopId);
  }

  getAllLoops(): LoopState[] {
    return Array.from(this.loops.values());
  }

  getActiveLoops(): LoopState[] {
    return this.getAllLoops().filter(l => l.status === 'running');
  }

  getPendingLoops(): LoopState[] {
    return this.getAllLoops().filter(l => l.status === 'pending');
  }

  updateLoopStatus(loopId: string, status: LoopState['status']): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.status = status;
    }
  }

  incrementIteration(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.iteration++;
    }
  }

  needsReview(loopId: string): boolean {
    const loop = this.loops.get(loopId);
    if (!loop) return false;

    return (loop.iteration - loop.lastReviewAt) >= loop.reviewInterval;
  }

  markReviewed(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.lastReviewAt = loop.iteration;
    }
  }

  appendOutput(loopId: string, text: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.output.push(text);
      // Keep only last 100 lines for TUI
      if (loop.output.length > 100) {
        loop.output = loop.output.slice(-100);
      }
    }
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `npm test -- src/loops/manager.test.ts`
Expected: All tests pass

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: implement loop manager for parallel execution"
```

---

## Task 10: Stuck Detection

**Files:**
- Create: `src/loops/stuck-detection.ts`
- Test: `src/loops/stuck-detection.test.ts`

**Step 1: Write failing test**

Create `src/loops/stuck-detection.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { detectStuck, StuckReason } from './stuck-detection.js';
import type { LoopState } from '../types/index.js';

describe('Stuck Detection', () => {
  const baseLoop: LoopState = {
    loopId: 'test',
    taskIds: ['t1'],
    iteration: 10,
    maxIterations: 20,
    reviewInterval: 5,
    lastReviewAt: 5,
    status: 'running',
    stuckIndicators: {
      sameErrorCount: 0,
      noProgressCount: 0,
      lastError: null,
      lastFileChangeIteration: 10,
    },
    output: [],
  };

  test('returns null when not stuck', () => {
    const result = detectStuck(baseLoop, { stuckThreshold: 3 });
    assert.strictEqual(result, null);
  });

  test('detects same error repeated', () => {
    const loop = {
      ...baseLoop,
      stuckIndicators: {
        ...baseLoop.stuckIndicators,
        sameErrorCount: 4,
        lastError: 'TypeError: cannot read property',
      },
    };

    const result = detectStuck(loop, { stuckThreshold: 3 });

    assert.strictEqual(result?.reason, StuckReason.REPEATED_ERROR);
  });

  test('detects no progress', () => {
    const loop = {
      ...baseLoop,
      iteration: 15,
      stuckIndicators: {
        ...baseLoop.stuckIndicators,
        noProgressCount: 5,
        lastFileChangeIteration: 10,
      },
    };

    const result = detectStuck(loop, { stuckThreshold: 3 });

    assert.strictEqual(result?.reason, StuckReason.NO_PROGRESS);
  });

  test('detects max iterations exceeded', () => {
    const loop = {
      ...baseLoop,
      iteration: 21,
    };

    const result = detectStuck(loop, { stuckThreshold: 3 });

    assert.strictEqual(result?.reason, StuckReason.MAX_ITERATIONS);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/loops/stuck-detection.test.ts`
Expected: FAIL - module not found

**Step 3: Implement stuck detection**

Create `src/loops/stuck-detection.ts`:
```typescript
import type { LoopState } from '../types/index.js';

export enum StuckReason {
  REPEATED_ERROR = 'repeated_error',
  NO_PROGRESS = 'no_progress',
  MAX_ITERATIONS = 'max_iterations',
}

export interface StuckResult {
  reason: StuckReason;
  details: string;
  suggestion: string;
}

export interface StuckConfig {
  stuckThreshold: number;
}

export function detectStuck(loop: LoopState, config: StuckConfig): StuckResult | null {
  const { stuckIndicators, iteration, maxIterations } = loop;

  // Check max iterations first
  if (iteration > maxIterations) {
    return {
      reason: StuckReason.MAX_ITERATIONS,
      details: `Exceeded max iterations (${maxIterations})`,
      suggestion: 'Consider breaking task into smaller pieces or increasing max iterations',
    };
  }

  // Check repeated same error
  if (stuckIndicators.sameErrorCount >= config.stuckThreshold) {
    return {
      reason: StuckReason.REPEATED_ERROR,
      details: `Same error repeated ${stuckIndicators.sameErrorCount} times: ${stuckIndicators.lastError}`,
      suggestion: 'Try a different approach or provide more context',
    };
  }

  // Check no file changes (no progress)
  const iterationsSinceChange = iteration - stuckIndicators.lastFileChangeIteration;
  if (stuckIndicators.noProgressCount >= config.stuckThreshold || iterationsSinceChange >= config.stuckThreshold + 2) {
    return {
      reason: StuckReason.NO_PROGRESS,
      details: `No file changes in ${iterationsSinceChange} iterations`,
      suggestion: 'Agent may be confused about the task or blocked by an issue',
    };
  }

  return null;
}

export function updateStuckIndicators(
  loop: LoopState,
  error: string | null,
  filesChanged: boolean
): void {
  if (error) {
    if (error === loop.stuckIndicators.lastError) {
      loop.stuckIndicators.sameErrorCount++;
    } else {
      loop.stuckIndicators.sameErrorCount = 1;
      loop.stuckIndicators.lastError = error;
    }
  } else {
    loop.stuckIndicators.sameErrorCount = 0;
    loop.stuckIndicators.lastError = null;
  }

  if (filesChanged) {
    loop.stuckIndicators.lastFileChangeIteration = loop.iteration;
    loop.stuckIndicators.noProgressCount = 0;
  } else {
    loop.stuckIndicators.noProgressCount++;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/loops/stuck-detection.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement stuck detection for loops"
```

---

## Task 11: Build Phase

**Files:**
- Create: `src/orchestrator/phases/build.ts`
- Test: `src/orchestrator/phases/build.test.ts`

**Step 1: Write failing test**

Create `src/orchestrator/phases/build.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { getNextParallelGroup, canStartGroup } from './build.js';
import type { Task, TaskGraph } from '../../types/index.js';

describe('Build Phase', () => {
  const tasks: Task[] = [
    { id: 't1', title: 'Task 1', description: '', status: 'pending', dependencies: [], estimatedIterations: 5, assignedLoopId: null },
    { id: 't2', title: 'Task 2', description: '', status: 'pending', dependencies: [], estimatedIterations: 5, assignedLoopId: null },
    { id: 't3', title: 'Task 3', description: '', status: 'pending', dependencies: ['t1', 't2'], estimatedIterations: 5, assignedLoopId: null },
  ];

  const graph: TaskGraph = {
    tasks,
    parallelGroups: [['t1', 't2'], ['t3']],
  };

  test('getNextParallelGroup returns first incomplete group', () => {
    const completedTasks: string[] = [];
    const group = getNextParallelGroup(graph, completedTasks);

    assert.deepStrictEqual(group, ['t1', 't2']);
  });

  test('getNextParallelGroup returns second group when first complete', () => {
    const completedTasks = ['t1', 't2'];
    const group = getNextParallelGroup(graph, completedTasks);

    assert.deepStrictEqual(group, ['t3']);
  });

  test('getNextParallelGroup returns null when all complete', () => {
    const completedTasks = ['t1', 't2', 't3'];
    const group = getNextParallelGroup(graph, completedTasks);

    assert.strictEqual(group, null);
  });

  test('canStartGroup checks dependencies are met', () => {
    assert.strictEqual(canStartGroup(['t1', 't2'], [], tasks), true);
    assert.strictEqual(canStartGroup(['t3'], [], tasks), false);
    assert.strictEqual(canStartGroup(['t3'], ['t1', 't2'], tasks), true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/orchestrator/phases/build.test.ts`
Expected: FAIL - module not found

**Step 3: Implement build phase**

Create `src/orchestrator/phases/build.ts`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, Task, TaskGraph, LoopState } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { BUILD_PROMPT } from '../../agents/prompts.js';
import { LoopManager } from '../../loops/manager.js';
import { detectStuck, updateStuckIndicators } from '../../loops/stuck-detection.js';
import { getEffortConfig } from '../../config/effort.js';

export function getNextParallelGroup(
  graph: TaskGraph,
  completedTasks: string[]
): string[] | null {
  for (const group of graph.parallelGroups) {
    const allComplete = group.every(id => completedTasks.includes(id));
    if (!allComplete) {
      // Return tasks from this group that aren't complete
      return group.filter(id => !completedTasks.includes(id));
    }
  }
  return null;
}

export function canStartGroup(
  taskIds: string[],
  completedTasks: string[],
  allTasks: Task[]
): boolean {
  for (const taskId of taskIds) {
    const task = allTasks.find(t => t.id === taskId);
    if (!task) continue;

    const depsComplete = task.dependencies.every(dep => completedTasks.includes(dep));
    if (!depsComplete) return false;
  }
  return true;
}

export interface BuildResult {
  completedTasks: string[];
  activeLoops: LoopState[];
  needsReview: boolean;
  stuck: boolean;
}

export async function executeBuildIteration(
  state: OrchestratorState,
  loopManager: LoopManager,
  onLoopOutput?: (loopId: string, text: string) => void
): Promise<BuildResult> {
  const graph = state.taskGraph!;
  const config = createAgentConfig('build', process.cwd());
  const effortConfig = getEffortConfig(state.effort);

  // Check for stuck loops
  for (const loop of loopManager.getActiveLoops()) {
    const stuckResult = detectStuck(loop, { stuckThreshold: effortConfig.stuckThreshold });
    if (stuckResult) {
      loopManager.updateLoopStatus(loop.loopId, 'stuck');
      return {
        completedTasks: state.completedTasks,
        activeLoops: loopManager.getAllLoops(),
        needsReview: true,
        stuck: true,
      };
    }
  }

  // Spawn new loops for available tasks
  const nextGroup = getNextParallelGroup(graph, state.completedTasks);
  if (nextGroup && canStartGroup(nextGroup, state.completedTasks, state.tasks)) {
    while (loopManager.canSpawnMore() && nextGroup.length > 0) {
      const taskId = nextGroup.shift()!;
      const task = state.tasks.find(t => t.id === taskId)!;
      const loop = loopManager.createLoop([taskId], state.tasks);
      loopManager.updateLoopStatus(loop.loopId, 'running');
    }
  }

  // Execute one iteration for each active loop
  const loopPromises = loopManager.getActiveLoops().map(async (loop) => {
    const task = state.tasks.find(t => t.id === loop.taskIds[0])!;
    const prompt = `${BUILD_PROMPT}

## Current Task:
ID: ${task.id}
Title: ${task.title}
Description: ${task.description}

## Iteration: ${loop.iteration + 1}/${loop.maxIterations}`;

    let output = '';
    let hasError = false;
    let errorMessage: string | null = null;

    try {
      for await (const message of query({
        prompt,
        options: {
          allowedTools: config.allowedTools,
          permissionMode: config.permissionMode,
          maxTurns: 10, // Single iteration limit
        },
      })) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block) {
              output += block.text;
              onLoopOutput?.(loop.loopId, block.text);
              loopManager.appendOutput(loop.loopId, block.text);
            }
          }
        }
      }

      // Check for completion signal
      if (output.includes('TASK_COMPLETE')) {
        loopManager.updateLoopStatus(loop.loopId, 'completed');
        return { loopId: loop.loopId, taskId: task.id, completed: true };
      }

      // Check for stuck signal
      if (output.includes('TASK_STUCK:')) {
        const stuckMatch = output.match(/TASK_STUCK:\s*(.+)/);
        errorMessage = stuckMatch?.[1] || 'Unknown reason';
        hasError = true;
      }
    } catch (e) {
      hasError = true;
      errorMessage = String(e);
    }

    loopManager.incrementIteration(loop.loopId);
    updateStuckIndicators(loop, errorMessage, !hasError);

    return { loopId: loop.loopId, taskId: task.id, completed: false };
  });

  const results = await Promise.all(loopPromises);
  const newlyCompleted = results.filter(r => r.completed).map(r => r.taskId);

  // Check if any loop needs review
  const needsReview = loopManager.getActiveLoops().some(loop =>
    loopManager.needsReview(loop.loopId)
  );

  return {
    completedTasks: [...state.completedTasks, ...newlyCompleted],
    activeLoops: loopManager.getAllLoops(),
    needsReview,
    stuck: false,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/orchestrator/phases/build.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement build phase with parallel loop execution"
```

---

## Task 12: Review Phase

**Files:**
- Create: `src/orchestrator/phases/review.ts`
- Test: `src/orchestrator/phases/review.test.ts`

**Step 1: Write failing test**

Create `src/orchestrator/phases/review.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseReviewOutput, getReviewPrompt } from './review.js';

describe('Review Phase', () => {
  test('parseReviewOutput extracts passed status', () => {
    const output = `\`\`\`json
{
  "passed": true,
  "issues": [],
  "suggestions": ["Consider adding more tests"]
}
\`\`\``;

    const result = parseReviewOutput(output);

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.issues.length, 0);
  });

  test('parseReviewOutput extracts issues', () => {
    const output = `\`\`\`json
{
  "passed": false,
  "issues": ["Missing error handling", "No tests"],
  "suggestions": []
}
\`\`\``;

    const result = parseReviewOutput(output);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.issues.length, 2);
  });

  test('getReviewPrompt varies by depth', () => {
    const shallow = getReviewPrompt('shallow');
    const deep = getReviewPrompt('deep');

    assert.ok(shallow.includes('basic'));
    assert.ok(deep.includes('comprehensive'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/orchestrator/phases/review.test.ts`
Expected: FAIL - module not found

**Step 3: Implement review phase**

Create `src/orchestrator/phases/review.ts`:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, ReviewType } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import type { EffortConfig } from '../../config/effort.js';

export interface ReviewResult {
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

export function parseReviewOutput(output: string): ReviewResult {
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    output.match(/(\{[\s\S]*"passed"[\s\S]*\})/);

  if (!jsonMatch) {
    // Default to failed if can't parse
    return { passed: false, issues: ['Failed to parse review output'], suggestions: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    return {
      passed: parsed.passed ?? false,
      issues: parsed.issues ?? [],
      suggestions: parsed.suggestions ?? [],
    };
  } catch {
    return { passed: false, issues: ['Failed to parse review JSON'], suggestions: [] };
  }
}

export function getReviewPrompt(depth: EffortConfig['reviewDepth']): string {
  const base = `You are a code reviewer. Evaluate the work done.

Output a JSON object:
{
  "passed": true/false,
  "issues": ["list of issues if any"],
  "suggestions": ["optional improvements"]
}`;

  switch (depth) {
    case 'shallow':
      return `${base}

Perform a basic review:
- Do tests pass?
- Are there obvious bugs?`;

    case 'standard':
      return `${base}

Perform a standard review:
- Do tests pass?
- Does the code match the plan?
- Are there bugs or edge cases?`;

    case 'deep':
      return `${base}

Perform a comprehensive review:
- Do tests pass?
- Does implementation match spec?
- Are edge cases handled?
- Is error handling adequate?
- Is the approach optimal?`;

    case 'comprehensive':
      return `${base}

Perform an exhaustive review:
- Do all tests pass?
- Full spec compliance check
- Security analysis
- Performance analysis
- Edge case coverage
- Code quality assessment
- Documentation completeness`;
  }
}

export async function executeReview(
  state: OrchestratorState,
  reviewType: ReviewType,
  depth: EffortConfig['reviewDepth'],
  onOutput?: (text: string) => void
): Promise<ReviewResult> {
  const config = createAgentConfig('review', process.cwd());

  let context = '';
  switch (reviewType) {
    case 'enumerate':
      context = `Review the enumerated tasks:\n${JSON.stringify(state.tasks, null, 2)}`;
      break;
    case 'plan':
      context = `Review the execution plan:\n${JSON.stringify(state.taskGraph, null, 2)}`;
      break;
    case 'build':
      context = `Review the completed work. Tasks completed: ${state.completedTasks.join(', ')}`;
      break;
  }

  const prompt = `${getReviewPrompt(depth)}

## Context:
${context}

## Spec:
File: ${state.specPath}`;

  let fullOutput = '';

  for await (const message of query({
    prompt,
    options: {
      allowedTools: config.allowedTools,
      permissionMode: config.permissionMode,
      maxTurns: config.maxTurns,
    },
  })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block) {
          fullOutput += block.text;
          onOutput?.(block.text);
        }
      }
    }
  }

  return parseReviewOutput(fullOutput);
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- src/orchestrator/phases/review.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement review phase with configurable depth"
```

---

## Task 13: Orchestrator Core

**Files:**
- Create: `src/orchestrator/index.ts`
- Modify: `src/index.ts`

**Step 1: Create orchestrator core**

Create `src/orchestrator/index.ts`:
```typescript
import type { OrchestratorState, Phase } from '../types/index.js';
import { saveState } from '../state/index.js';
import { getEffortConfig } from '../config/effort.js';
import { LoopManager } from '../loops/manager.js';
import { executeEnumerate } from './phases/enumerate.js';
import { executePlan } from './phases/plan.js';
import { executeBuildIteration, getNextParallelGroup } from './phases/build.js';
import { executeReview } from './phases/review.js';

export interface OrchestratorCallbacks {
  onPhaseStart?: (phase: Phase) => void;
  onPhaseComplete?: (phase: Phase, success: boolean) => void;
  onOutput?: (text: string) => void;
  onLoopOutput?: (loopId: string, text: string) => void;
}

export async function runOrchestrator(
  state: OrchestratorState,
  callbacks: OrchestratorCallbacks = {}
): Promise<OrchestratorState> {
  const effortConfig = getEffortConfig(state.effort);

  callbacks.onPhaseStart?.(state.phase);

  try {
    switch (state.phase) {
      case 'enumerate': {
        const tasks = await executeEnumerate(state, callbacks.onOutput);
        state.tasks = tasks;
        state.phaseHistory.push({
          phase: 'enumerate',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Enumerated ${tasks.length} tasks`,
        });

        // Check if we need to review
        if (effortConfig.reviewAfterEnumerate) {
          state.pendingReview = true;
          state.reviewType = 'enumerate';
          state.phase = 'review';
        } else {
          state.phase = 'plan';
        }
        break;
      }

      case 'plan': {
        const taskGraph = await executePlan(state, callbacks.onOutput);
        state.taskGraph = taskGraph;
        state.phaseHistory.push({
          phase: 'plan',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Created plan with ${taskGraph.parallelGroups.length} parallel groups`,
        });

        if (effortConfig.reviewAfterPlan) {
          state.pendingReview = true;
          state.reviewType = 'plan';
          state.phase = 'review';
        } else {
          state.phase = 'build';
        }
        break;
      }

      case 'build': {
        const loopManager = new LoopManager({
          maxLoops: state.maxLoops,
          maxIterations: state.maxIterations,
          reviewInterval: effortConfig.reviewInterval,
        });

        // Restore active loops from state
        for (const loop of state.activeLoops) {
          // Re-create in manager (simplified - in real impl would restore fully)
        }

        const result = await executeBuildIteration(
          state,
          loopManager,
          callbacks.onLoopOutput
        );

        state.completedTasks = result.completedTasks;
        state.activeLoops = result.activeLoops;

        if (result.stuck) {
          state.phase = 'revise';
        } else if (result.needsReview) {
          state.pendingReview = true;
          state.reviewType = 'build';
          state.phase = 'review';
        } else if (!getNextParallelGroup(state.taskGraph!, state.completedTasks)) {
          // All tasks complete
          state.phase = 'review';
          state.reviewType = 'build';
          state.pendingReview = true;
        }
        // Otherwise stay in build phase for next iteration
        break;
      }

      case 'review': {
        const result = await executeReview(
          state,
          state.reviewType,
          effortConfig.reviewDepth,
          callbacks.onOutput
        );

        state.phaseHistory.push({
          phase: 'review',
          success: result.passed,
          timestamp: new Date().toISOString(),
          summary: result.passed
            ? 'Review passed'
            : `Review failed: ${result.issues.join(', ')}`,
        });

        state.pendingReview = false;

        if (result.passed) {
          // Determine next phase based on what we reviewed
          switch (state.reviewType) {
            case 'enumerate':
              state.phase = 'plan';
              break;
            case 'plan':
              state.phase = 'build';
              break;
            case 'build':
              // Check if all tasks complete
              if (state.completedTasks.length === state.tasks.length) {
                state.phase = 'complete';
              } else {
                state.phase = 'build';
              }
              break;
          }
        } else {
          state.phase = 'revise';
          state.context.errors.push(...result.issues);
        }
        state.reviewType = null;
        break;
      }

      case 'revise': {
        state.revisionCount++;
        // Go back to build phase with context about what to fix
        state.phase = 'build';
        state.phaseHistory.push({
          phase: 'revise',
          success: true,
          timestamp: new Date().toISOString(),
          summary: `Revision ${state.revisionCount} - returning to build`,
        });
        break;
      }

      case 'complete': {
        // Nothing to do - orchestrator will exit
        break;
      }
    }

    callbacks.onPhaseComplete?.(state.phase, true);
  } catch (error) {
    state.context.errors.push(String(error));
    callbacks.onPhaseComplete?.(state.phase, false);
  }

  await saveState(state);
  return state;
}

export function getExitCode(state: OrchestratorState): number {
  if (state.phase === 'complete') return 0;
  if (state.activeLoops.some(l => l.status === 'stuck')) return 2;
  if (state.context.errors.length > 0) return 1;
  return 0; // Still running, will be restarted by outer loop
}
```

**Step 2: Update main entry point**

Update `src/index.ts`:
```typescript
#!/usr/bin/env node
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createCLI } from './cli.js';
import { loadState, saveState, initializeState } from './state/index.js';
import { runOrchestrator, getExitCode } from './orchestrator/index.js';

async function main() {
  const program = createCLI();
  program.parse();
  const opts = program.opts();

  // Validate spec file exists
  const specPath = resolve(opts.spec);
  try {
    await access(specPath);
  } catch {
    console.error(`Error: Spec file not found: ${specPath}`);
    process.exit(1);
  }

  const stateDir = resolve(opts.stateDir);

  // Load or initialize state
  let state = opts.reset ? null : await loadState(stateDir);

  if (!state) {
    state = initializeState({
      specPath,
      effort: opts.effort,
      stateDir,
      maxLoops: parseInt(opts.maxLoops, 10),
      maxIterations: parseInt(opts.maxIterations, 10),
    });
    console.log(`Initialized new run: ${state.runId}`);
  } else {
    console.log(`Resuming run: ${state.runId}`);
  }

  console.log(`Phase: ${state.phase}`);
  console.log(`Effort: ${state.effort}`);

  if (opts.dryRun) {
    console.log('[dry-run] Would execute phase:', state.phase);
    return;
  }

  if (state.phase === 'complete') {
    console.log('Run already complete!');
    process.exit(0);
  }

  // Run one phase
  state = await runOrchestrator(state, {
    onPhaseStart: (phase) => console.log(`Starting phase: ${phase}`),
    onPhaseComplete: (phase, success) =>
      console.log(`Phase ${phase} ${success ? 'completed' : 'failed'}`),
    onOutput: (text) => process.stdout.write(text),
    onLoopOutput: (loopId, text) =>
      console.log(`[${loopId.slice(0, 8)}] ${text}`),
  });

  const exitCode = getExitCode(state);

  if (state.phase === 'complete') {
    console.log('\n✓ All tasks completed successfully!');
  } else if (exitCode === 2) {
    console.log('\n⚠ Loop stuck - needs intervention');
  } else {
    console.log(`\nPhase complete. Next: ${state.phase}`);
    console.log('Run again to continue (or use outer Ralph loop)');
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Step 3: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors (or only SDK import errors if SDK not installed)

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: implement orchestrator core with phase execution"
```

---

## Task 14: TUI - Basic Layout

**Files:**
- Create: `src/tui/index.tsx`
- Create: `src/tui/Layout.tsx`
- Create: `src/tui/Header.tsx`

**Step 1: Install ink dependencies**

Run:
```bash
npm install ink ink-box react
npm install -D @types/react
```

**Step 2: Update tsconfig for JSX**

Add to tsconfig.json compilerOptions:
```json
{
  "jsx": "react-jsx",
  "jsxImportSource": "react"
}
```

**Step 3: Create Header component**

Create `src/tui/Header.tsx`:
```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { OrchestratorState } from '../types/index.js';

interface HeaderProps {
  state: OrchestratorState;
  activeLoopCount: number;
}

export function Header({ state, activeLoopCount }: HeaderProps) {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text bold>c2 orchestrator</Text>
      <Text> │ </Text>
      <Text>phase: </Text>
      <Text color="cyan">{state.phase}</Text>
      <Text> │ </Text>
      <Text>effort: </Text>
      <Text color="yellow">{state.effort}</Text>
      <Text> │ </Text>
      <Text>loops: </Text>
      <Text color="green">{activeLoopCount}/{state.maxLoops}</Text>
      <Text> │ </Text>
      <Text>tasks: </Text>
      <Text color="magenta">{state.completedTasks.length}/{state.tasks.length}</Text>
    </Box>
  );
}
```

**Step 4: Create Column component**

Create `src/tui/Column.tsx`:
```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { LoopState } from '../types/index.js';

interface ColumnProps {
  loop: LoopState;
  taskTitle: string;
}

function getStatusIndicator(status: LoopState['status']): { symbol: string; color: string } {
  switch (status) {
    case 'running': return { symbol: '⟳', color: 'yellow' };
    case 'completed': return { symbol: '✓', color: 'green' };
    case 'failed': return { symbol: '✗', color: 'red' };
    case 'stuck': return { symbol: '!', color: 'red' };
    default: return { symbol: '○', color: 'gray' };
  }
}

export function Column({ loop, taskTitle }: ColumnProps) {
  const status = getStatusIndicator(loop.status);
  const recentOutput = loop.output.slice(-10);

  return (
    <Box flexDirection="column" borderStyle="single" width="33%" minHeight={15}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold>{loop.loopId.slice(0, 8)}</Text>
      </Box>

      {/* Task info */}
      <Box paddingX={1}>
        <Text dimColor>task: </Text>
        <Text>{taskTitle.slice(0, 20)}</Text>
      </Box>

      {/* Status */}
      <Box paddingX={1}>
        <Text dimColor>iter: </Text>
        <Text>{loop.iteration}/{loop.maxIterations}</Text>
        <Text> </Text>
        <Text color={status.color}>{status.symbol}</Text>
        <Text> </Text>
        <Text color={status.color}>{loop.status}</Text>
      </Box>

      {/* Divider */}
      <Box paddingX={1}>
        <Text dimColor>{'─'.repeat(28)}</Text>
      </Box>

      {/* Output */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {recentOutput.map((line, i) => (
          <Text key={i} wrap="truncate">{line.slice(0, 30)}</Text>
        ))}
      </Box>
    </Box>
  );
}
```

**Step 5: Create Layout component**

Create `src/tui/Layout.tsx`:
```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { OrchestratorState, LoopState } from '../types/index.js';
import { Header } from './Header.js';
import { Column } from './Column.js';

interface LayoutProps {
  state: OrchestratorState;
  loops: LoopState[];
}

export function Layout({ state, loops }: LayoutProps) {
  const activeLoops = loops.filter(l => l.status === 'running' || l.status === 'pending');

  return (
    <Box flexDirection="column">
      <Header state={state} activeLoopCount={activeLoops.length} />

      {/* Loop columns */}
      <Box>
        {loops.slice(0, state.maxLoops).map(loop => {
          const task = state.tasks.find(t => t.id === loop.taskIds[0]);
          return (
            <Column
              key={loop.loopId}
              loop={loop}
              taskTitle={task?.title || 'Unknown'}
            />
          );
        })}

        {/* Empty columns if fewer loops than max */}
        {Array.from({ length: Math.max(0, state.maxLoops - loops.length) }).map((_, i) => (
          <Box key={`empty-${i}`} borderStyle="single" width="33%" minHeight={15}>
            <Box paddingX={1}>
              <Text dimColor>No active loop</Text>
            </Box>
          </Box>
        ))}
      </Box>

      {/* Footer */}
      <Box borderStyle="single" paddingX={1}>
        <Text dimColor>[q]uit  [p]ause  [r]eview now  [1-4] focus</Text>
      </Box>
    </Box>
  );
}
```

**Step 6: Create TUI entry point**

Create `src/tui/index.tsx`:
```tsx
import React, { useState, useEffect } from 'react';
import { render, useInput, useApp } from 'ink';
import type { OrchestratorState, LoopState } from '../types/index.js';
import { Layout } from './Layout.js';

interface TUIProps {
  initialState: OrchestratorState;
  onQuit?: () => void;
}

function TUI({ initialState, onQuit }: TUIProps) {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const [loops, setLoops] = useState<LoopState[]>(initialState.activeLoops);

  useInput((input, key) => {
    if (input === 'q') {
      onQuit?.();
      exit();
    }
  });

  return <Layout state={state} loops={loops} />;
}

export function startTUI(state: OrchestratorState): void {
  render(<TUI initialState={state} />);
}

export { Layout, Header } from './Layout.js';
```

**Step 7: Verify TUI compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: implement TUI with ink for multi-column display"
```

---

## Task 15: Integration & Polish

**Files:**
- Create: `src/tui/App.tsx`
- Modify: `src/index.ts`
- Create: `bin/c2`

**Step 1: Create TUI App with orchestrator integration**

Create `src/tui/App.tsx`:
```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { useApp, useInput } from 'ink';
import type { OrchestratorState, LoopState } from '../types/index.js';
import { runOrchestrator } from '../orchestrator/index.js';
import { Layout } from './Layout.js';

interface AppProps {
  initialState: OrchestratorState;
}

export function App({ initialState }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const [loops, setLoops] = useState<LoopState[]>(initialState.activeLoops);
  const [running, setRunning] = useState(true);

  useInput((input) => {
    if (input === 'q') {
      setRunning(false);
      exit();
    }
    if (input === 'p') {
      setRunning(prev => !prev);
    }
  });

  const runPhase = useCallback(async () => {
    if (!running || state.phase === 'complete') return;

    const newState = await runOrchestrator(state, {
      onLoopOutput: (loopId, text) => {
        setLoops(prev => prev.map(l =>
          l.loopId === loopId
            ? { ...l, output: [...l.output.slice(-99), text] }
            : l
        ));
      },
    });

    setState(newState);
    setLoops(newState.activeLoops);
  }, [state, running]);

  useEffect(() => {
    if (running && state.phase !== 'complete') {
      runPhase();
    }
  }, [running, state.phase]);

  return <Layout state={state} loops={loops} />;
}
```

**Step 2: Add TUI mode to CLI**

Update `src/cli.ts` to add --tui flag:
```typescript
// Add to createCLI():
.option('--tui', 'Run with TUI interface', false)
```

**Step 3: Update entry point for TUI mode**

Update the main function in `src/index.ts` to conditionally start TUI:
```typescript
// After state initialization, before running orchestrator:
if (opts.tui) {
  const { render } = await import('ink');
  const { App } = await import('./tui/App.js');
  const React = await import('react');

  render(React.createElement(App, { initialState: state }));
  return; // TUI handles everything
}

// ... rest of existing code for non-TUI mode
```

**Step 4: Create executable bin script**

Create `bin/c2`:
```bash
#!/usr/bin/env node
import('../dist/index.js');
```

Make it executable:
```bash
chmod +x bin/c2
```

**Step 5: Update package.json bin entry**

```json
{
  "bin": {
    "c2": "./bin/c2"
  }
}
```

**Step 6: Build and test**

Run:
```bash
npm run build
npm link
c2 --help
```

Expected: Shows help output

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add TUI mode and polish CLI integration"
```

---

## Task 16: Final Integration Test

**Step 1: Create a test spec**

Create `examples/hello-world-spec.md`:
```markdown
# Hello World Feature

Create a simple greeting module.

## Requirements

1. Create `src/greet.ts` with a `greet(name: string)` function
2. Returns "Hello, {name}!" for valid names
3. Returns "Hello, World!" for empty string
4. Add tests in `src/greet.test.ts`
```

**Step 2: Run end-to-end test**

Run:
```bash
c2 --spec examples/hello-world-spec.md --effort medium --dry-run
```

Expected: Shows initialized state and phase info

**Step 3: Test resume behavior**

Run:
```bash
c2 --spec examples/hello-world-spec.md --effort medium --dry-run
```

Expected: Shows "Resuming run" message

**Step 4: Test reset behavior**

Run:
```bash
c2 --spec examples/hello-world-spec.md --reset --dry-run
```

Expected: Shows "Initialized new run" message

**Step 5: Commit final state**

```bash
git add -A
git commit -m "chore: add example specs and finalize integration"
```

---

## Summary

The implementation is broken into 18 tasks (including risk mitigation tasks):

1. **Project Scaffolding** - package.json, tsconfig, dependencies (incl. better-sqlite3, MCP SDK)
2. **Core Types** - State, Task, Loop, Cost type definitions
3. **SQLite Database** - Schema and database module for persistent state
3A. **MCP Server** - Agent→DB communication via MCP tools (Risk #2 mitigation)
4. **CLI Entry Point** - Commander-based CLI parsing
5. **Effort Configuration** - Effort level configs with cost limits (Risk #3)
6. **Agent Spawning** - Claude SDK wrapper with MCP server integration
6A. **Prompt Testing Harness** - Validate prompts before deployment (Risk #1)
7. **Enumerate Phase** - Task creation via MCP tools with granularity validation (Risk #5)
8. **Plan Phase** - Parallel group creation via MCP tools
9. **Loop Manager** - Parallel loop coordination
10. **Stuck Detection** - Loop health monitoring with logging
11. **Build Phase** - Parallel task execution with cost tracking
12. **Review Phase** - Configurable review depth
13. **Orchestrator Core** - Phase state machine with cost enforcement
14. **TUI Layout** - Ink multi-column display
15. **Integration** - TUI + orchestrator wiring
16. **Final Test** - End-to-end validation

**Architecture:**
- **SQLite** (`.c2/state.db`) stores all state - no JSON files
- **MCP Server** (`c2-mcp`) exposes DB operations as tools
- **Agents** call MCP tools directly instead of outputting JSON
- **No parsing needed** - tool parameters are already structured

**Risk Mitigations Integrated:**
- **Risk #1 (Prompts)**: Task 6A adds prompt testing harness
- **Risk #2 (JSON Parsing)**: Eliminated - agents write to SQLite via MCP tools
- **Risk #3 (Costs)**: Tasks 2, 5, 13 add cost tracking and limits
- **Risk #4 (Stuck Detection)**: Task 10 has configurable thresholds
- **Risk #5 (Granularity)**: Task 7 validates task sizing

Each task follows TDD with explicit test-first steps and commits.
