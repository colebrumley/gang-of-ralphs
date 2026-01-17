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

## Task 3: State Management

**Files:**
- Create: `src/state/schema.ts`
- Create: `src/state/index.ts`
- Test: `src/state/state.test.ts`

**Step 1: Create state directory**

Run: `mkdir -p src/state`

**Step 2: Write failing test for state load/save**

Create `src/state/state.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, initializeState } from './index.js';

describe('State Management', () => {
  test('initializeState creates valid initial state', async () => {
    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: '.c2',
      maxLoops: 4,
      maxIterations: 20,
    });

    assert.strictEqual(state.phase, 'enumerate');
    assert.strictEqual(state.effort, 'medium');
    assert.ok(state.runId);
  });

  test('saveState and loadState round-trip correctly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'c2-test-'));
    const stateDir = join(tempDir, '.c2');

    try {
      const state = initializeState({
        specPath: '/path/to/spec.md',
        effort: 'high',
        stateDir,
        maxLoops: 4,
        maxIterations: 20,
      });

      await saveState(state);
      const loaded = await loadState(stateDir);

      assert.deepStrictEqual(loaded, state);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  test('loadState returns null for non-existent state', async () => {
    const result = await loadState('/nonexistent/.c2');
    assert.strictEqual(result, null);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test -- src/state/state.test.ts`
Expected: FAIL - module not found

**Step 4: Create Zod schema**

Create `src/state/schema.ts`:
```typescript
import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  dependencies: z.array(z.string()),
  estimatedIterations: z.number(),
  assignedLoopId: z.string().nullable(),
});

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskSchema),
  parallelGroups: z.array(z.array(z.string())),
});

export const StuckIndicatorsSchema = z.object({
  sameErrorCount: z.number(),
  noProgressCount: z.number(),
  lastError: z.string().nullable(),
  lastFileChangeIteration: z.number(),
});

export const LoopStateSchema = z.object({
  loopId: z.string(),
  taskIds: z.array(z.string()),
  iteration: z.number(),
  maxIterations: z.number(),
  reviewInterval: z.number(),
  lastReviewAt: z.number(),
  status: z.enum(['pending', 'running', 'stuck', 'completed', 'failed']),
  stuckIndicators: StuckIndicatorsSchema,
  output: z.array(z.string()),
});

export const OrchestratorStateSchema = z.object({
  runId: z.string(),
  specPath: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'max']),
  phase: z.enum(['enumerate', 'plan', 'build', 'review', 'revise', 'complete']),
  phaseHistory: z.array(z.object({
    phase: z.enum(['enumerate', 'plan', 'build', 'review', 'revise', 'complete']),
    success: z.boolean(),
    timestamp: z.string(),
    summary: z.string(),
  })),
  tasks: z.array(TaskSchema),
  taskGraph: TaskGraphSchema.nullable(),
  activeLoops: z.array(LoopStateSchema),
  completedTasks: z.array(z.string()),
  pendingReview: z.boolean(),
  reviewType: z.enum(['enumerate', 'plan', 'build']).nullable(),
  revisionCount: z.number(),
  context: z.object({
    discoveries: z.array(z.string()),
    errors: z.array(z.string()),
    decisions: z.array(z.string()),
  }),
  maxLoops: z.number(),
  maxIterations: z.number(),
  stateDir: z.string(),
});
```

**Step 5: Implement state functions**

Create `src/state/index.ts`:
```typescript
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EffortLevel, OrchestratorState } from '../types/index.js';
import { OrchestratorStateSchema } from './schema.js';

const STATE_FILE = 'state.json';

export interface InitStateOptions {
  specPath: string;
  effort: EffortLevel;
  stateDir: string;
  maxLoops: number;
  maxIterations: number;
}

export function initializeState(options: InitStateOptions): OrchestratorState {
  return {
    runId: randomUUID(),
    specPath: options.specPath,
    effort: options.effort,
    phase: 'enumerate',
    phaseHistory: [],
    tasks: [],
    taskGraph: null,
    activeLoops: [],
    completedTasks: [],
    pendingReview: false,
    reviewType: null,
    revisionCount: 0,
    context: {
      discoveries: [],
      errors: [],
      decisions: [],
    },
    maxLoops: options.maxLoops,
    maxIterations: options.maxIterations,
    stateDir: options.stateDir,
  };
}

export async function saveState(state: OrchestratorState): Promise<void> {
  await mkdir(state.stateDir, { recursive: true });
  const filePath = join(state.stateDir, STATE_FILE);
  await writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function loadState(stateDir: string): Promise<OrchestratorState | null> {
  const filePath = join(stateDir, STATE_FILE);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return OrchestratorStateSchema.parse(parsed);
  } catch {
    return null;
  }
}

export { OrchestratorStateSchema } from './schema.js';
```

**Step 6: Run tests to verify they pass**

Run: `npm test -- src/state/state.test.ts`
Expected: All tests pass

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: implement state management with Zod validation"
```

---

## Task 3A: Robust JSON Parser (Risk #2 Mitigation)

**Files:**
- Create: `src/utils/json-parser.ts`
- Test: `src/utils/json-parser.test.ts`

**Step 1: Create utils directory**

Run: `mkdir -p src/utils`

**Step 2: Write failing tests for JSON extraction**

Create `src/utils/json-parser.test.ts`:
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractJSON, JSONExtractionError } from './json-parser.js';

describe('Robust JSON Parser', () => {
  test('extracts JSON from markdown code block', () => {
    const input = `Here's the result:
\`\`\`json
{"tasks": [{"id": "1"}]}
\`\`\`
Done!`;
    const result = extractJSON(input, ['tasks']);
    assert.deepStrictEqual(result, { tasks: [{ id: '1' }] });
  });

  test('extracts JSON from code block without language tag', () => {
    const input = `\`\`\`
{"tasks": []}
\`\`\``;
    const result = extractJSON(input, ['tasks']);
    assert.deepStrictEqual(result, { tasks: [] });
  });

  test('extracts raw JSON when no code block', () => {
    const input = `Thinking... {"tasks": [{"id": "1"}]} ...done`;
    const result = extractJSON(input, ['tasks']);
    assert.deepStrictEqual(result, { tasks: [{ id: '1' }] });
  });

  test('handles JSON with nested quotes and escapes', () => {
    const input = `\`\`\`json
{"title": "Say \\"hello\\"", "desc": "line1\\nline2"}
\`\`\``;
    const result = extractJSON(input, ['title']);
    assert.strictEqual(result.title, 'Say "hello"');
  });

  test('extracts last valid JSON when multiple present', () => {
    const input = `First: {"wrong": true}
Then: \`\`\`json
{"tasks": [{"id": "correct"}]}
\`\`\``;
    const result = extractJSON(input, ['tasks']);
    assert.strictEqual(result.tasks[0].id, 'correct');
  });

  test('throws JSONExtractionError with helpful message', () => {
    const input = 'No JSON here at all';
    assert.throws(
      () => extractJSON(input, ['tasks']),
      (err: Error) => {
        assert.ok(err instanceof JSONExtractionError);
        assert.ok(err.message.includes('No valid JSON found'));
        assert.ok(err.attempts.length > 0);
        return true;
      }
    );
  });

  test('validates required keys are present', () => {
    const input = '{"other": "value"}';
    assert.throws(
      () => extractJSON(input, ['tasks']),
      /Missing required key/
    );
  });

  test('repairs common JSON issues', () => {
    // Trailing comma
    const input1 = '{"tasks": [{"id": "1"},]}';
    const result1 = extractJSON(input1, ['tasks']);
    assert.ok(result1.tasks);

    // Single quotes (common LLM mistake)
    const input2 = "{'tasks': []}";
    const result2 = extractJSON(input2, ['tasks']);
    assert.ok(result2.tasks);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npm test -- src/utils/json-parser.test.ts`
Expected: FAIL - module not found

**Step 4: Implement robust JSON parser**

Create `src/utils/json-parser.ts`:
```typescript
export class JSONExtractionError extends Error {
  constructor(
    message: string,
    public readonly attempts: Array<{ strategy: string; error: string }>,
    public readonly rawInput: string
  ) {
    super(message);
    this.name = 'JSONExtractionError';
  }
}

interface ExtractionAttempt {
  strategy: string;
  error: string;
}

/**
 * Extract JSON from LLM output using multiple strategies.
 * Handles markdown code blocks, raw JSON, and common LLM formatting issues.
 */
export function extractJSON<T = unknown>(
  input: string,
  requiredKeys: string[] = []
): T {
  const attempts: ExtractionAttempt[] = [];

  // Strategy 1: Markdown code block with json tag
  const jsonBlockMatch = input.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      const result = parseWithRepair(jsonBlockMatch[1].trim());
      validateKeys(result, requiredKeys);
      return result as T;
    } catch (e) {
      attempts.push({ strategy: 'json code block', error: String(e) });
    }
  }

  // Strategy 2: Any markdown code block
  const anyBlockMatch = input.match(/```\s*([\s\S]*?)```/);
  if (anyBlockMatch && anyBlockMatch !== jsonBlockMatch) {
    try {
      const result = parseWithRepair(anyBlockMatch[1].trim());
      validateKeys(result, requiredKeys);
      return result as T;
    } catch (e) {
      attempts.push({ strategy: 'generic code block', error: String(e) });
    }
  }

  // Strategy 3: Find JSON object in text (greedy match for outermost braces)
  const objectMatch = input.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const result = parseWithRepair(objectMatch[0]);
      validateKeys(result, requiredKeys);
      return result as T;
    } catch (e) {
      attempts.push({ strategy: 'raw JSON object', error: String(e) });
    }
  }

  // Strategy 4: Find JSON array in text
  const arrayMatch = input.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const result = parseWithRepair(arrayMatch[0]);
      return result as T;
    } catch (e) {
      attempts.push({ strategy: 'raw JSON array', error: String(e) });
    }
  }

  throw new JSONExtractionError(
    `No valid JSON found containing required keys: ${requiredKeys.join(', ')}`,
    attempts,
    input.slice(0, 500) // Truncate for error message
  );
}

/**
 * Parse JSON with automatic repair of common LLM mistakes.
 */
function parseWithRepair(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Continue to repairs
  }

  let repaired = text;

  // Repair 1: Replace single quotes with double quotes (careful with apostrophes)
  repaired = repaired.replace(/'/g, '"');

  // Repair 2: Remove trailing commas before } or ]
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // Repair 3: Add missing quotes around unquoted keys
  repaired = repaired.replace(/(\{|\,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

  // Repair 4: Handle undefined/null written as literals
  repaired = repaired.replace(/:\s*undefined\b/g, ': null');

  try {
    return JSON.parse(repaired);
  } catch (e) {
    throw new Error(`JSON parse failed after repairs: ${e}`);
  }
}

function validateKeys(obj: unknown, requiredKeys: string[]): void {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Parsed result is not an object');
  }

  for (const key of requiredKeys) {
    if (!(key in obj)) {
      throw new Error(`Missing required key: ${key}`);
    }
  }
}

/**
 * Helper to create a retry prompt when JSON extraction fails.
 */
export function createRetryPrompt(error: JSONExtractionError): string {
  return `Your previous response could not be parsed as valid JSON.

Error: ${error.message}

Attempted strategies:
${error.attempts.map(a => `- ${a.strategy}: ${a.error}`).join('\n')}

Please respond with ONLY a valid JSON object. Do not include any text before or after the JSON.
The JSON must contain these keys: ${error.message.match(/required keys: (.+)/)?.[1] || 'unknown'}`;
}
```

**Step 5: Run tests to verify they pass**

Run: `npm test -- src/utils/json-parser.test.ts`
Expected: All tests pass

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add robust JSON parser with multi-strategy extraction and repair"
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
export const ENUMERATE_PROMPT = `You are a task enumerator. Given a spec file, break it down into discrete, implementable tasks.

Read the spec file and output a JSON array of tasks with this structure:
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Short title",
      "description": "What needs to be done",
      "dependencies": [],
      "estimatedIterations": 5
    }
  ]
}

Rules:
- Each task should be completable in 5-20 iterations
- Identify dependencies between tasks
- Order tasks so dependencies come first
- Be specific about what files/functions to create or modify`;

export const PLAN_PROMPT = `You are a task planner. Given a list of tasks, create an execution plan that maximizes parallelism.

Output a JSON object with this structure:
{
  "parallelGroups": [
    ["task-1", "task-2"],  // These can run in parallel
    ["task-3"],            // This depends on group 1
    ["task-4", "task-5"]   // These can run in parallel after task-3
  ],
  "reasoning": "Explanation of the plan"
}

Rules:
- Tasks with no dependencies can run in parallel
- Tasks depending on the same parent can run in parallel after parent completes
- Minimize total execution time`;

export const BUILD_PROMPT = `You are a code builder. Implement the assigned task.

Your task details are in the task file. Implement it following TDD:
1. Write a failing test
2. Implement minimal code to pass
3. Refactor if needed
4. Run tests to verify

When complete, output: TASK_COMPLETE
If stuck, output: TASK_STUCK: <reason>`;

export const REVIEW_PROMPT = `You are a code reviewer. Evaluate the work done so far.

Check:
1. Does the implementation match the spec?
2. Are there any bugs or edge cases missed?
3. Do all tests pass?
4. Is the code quality acceptable?

Output a JSON object:
{
  "passed": true/false,
  "issues": ["list of issues if any"],
  "suggestions": ["optional improvements"]
}`;
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
import type { Phase } from '../types/index.js';

export interface AgentConfig {
  cwd: string;
  allowedTools: string[];
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  maxTurns: number;
  systemPrompt?: string;
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

export function createAgentConfig(phase: Phase, cwd: string): AgentConfig {
  return {
    cwd,
    allowedTools: PHASE_TOOLS[phase],
    permissionMode: 'bypassPermissions',
    maxTurns: PHASE_MAX_TURNS[phase],
  };
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

1. **Project Scaffolding** - package.json, tsconfig, dependencies
2. **Core Types** - State, Task, Loop, Cost type definitions
3. **State Management** - Load/save with Zod validation
3A. **Robust JSON Parser** - Multi-strategy extraction with repair (Risk #2)
4. **CLI Entry Point** - Commander-based CLI parsing
5. **Effort Configuration** - Effort level configs with cost limits (Risk #3)
6. **Agent Spawning** - Claude SDK wrapper and prompts
6A. **Prompt Testing Harness** - Validate prompts before deployment (Risk #1)
7. **Enumerate Phase** - Task extraction with granularity validation (Risk #5)
8. **Plan Phase** - Parallel group planning
9. **Loop Manager** - Parallel loop coordination
10. **Stuck Detection** - Loop health monitoring with logging
11. **Build Phase** - Parallel task execution with cost tracking
12. **Review Phase** - Configurable review depth
13. **Orchestrator Core** - Phase state machine with cost enforcement
14. **TUI Layout** - Ink multi-column display
15. **Integration** - TUI + orchestrator wiring
16. **Final Test** - End-to-end validation

**Risk Mitigations Integrated:**
- **Risk #1 (Prompts)**: Task 6A adds prompt testing harness
- **Risk #2 (JSON)**: Task 3A adds robust multi-strategy JSON parser
- **Risk #3 (Costs)**: Tasks 2, 5, 13 add cost tracking and limits
- **Risk #4 (Stuck Detection)**: Task 10 has configurable thresholds
- **Risk #5 (Granularity)**: Task 7 validates task sizing

Each task follows TDD with explicit test-first steps and commits.
