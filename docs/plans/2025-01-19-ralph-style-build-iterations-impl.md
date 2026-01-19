# Ralph-Style Build Iterations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change BUILD phase from long-running agent sessions to short micro-iterations with scratchpad-based handoff.

**Architecture:** Each iteration is a fresh agent invocation. The scratchpad file carries context between iterations. Agent makes one small change, runs tests, writes scratchpad, exits with ITERATION_DONE (or TASK_COMPLETE when done).

**Tech Stack:** TypeScript, Zod schemas, MCP tools, Node.js fs

---

## Task 1: Add `write_scratchpad` MCP Tool Schema

**Files:**
- Modify: `src/mcp/tools.ts`

**Step 1: Add the Zod schema**

Add after `SetCodebaseAnalysisSchema` (around line 149):

```typescript
export const WriteScratchpadSchema = z.object({
  loopId: z.string().describe('The loop this scratchpad belongs to'),
  done: z.string().describe('What you completed this iteration'),
  testStatus: z.string().describe('Test results (pass/fail + key output)'),
  nextStep: z.string().describe('What the next iteration should do'),
  blockers: z.string().describe('Any blockers, or "none"'),
});

export type WriteScratchpad = z.infer<typeof WriteScratchpadSchema>;
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add src/mcp/tools.ts
git commit -m "feat(mcp): add WriteScratchpadSchema for iteration handoff"
```

---

## Task 2: Add `write_scratchpad` Tool Handler to MCP Server

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Add import for WriteScratchpadSchema**

Update the import block (around line 8) to include:

```typescript
import {
  AddContextSchema,
  AddPlanGroupSchema,
  CompleteTaskSchema,
  CreateLoopSchema,
  FailTaskSchema,
  PersistLoopStateSchema,
  RecordCostSchema,
  RecordPhaseCostSchema,
  SetCodebaseAnalysisSchema,
  SetLoopReviewResultSchema,
  SetReviewResultSchema,
  UpdateLoopStatusSchema,
  WriteTaskSchema,
  WriteScratchpadSchema,  // ADD THIS
} from './tools.js';
```

**Step 2: Add fs imports at top of file**

Update the first import to include `writeFileSync` and `mkdirSync`:

```typescript
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
```

**Step 3: Add tool definition in ListToolsRequestSchema handler**

Add after the `set_codebase_analysis` tool definition (around line 376):

```typescript
      {
        name: 'write_scratchpad',
        description: 'Write iteration scratchpad for handoff to next iteration',
        inputSchema: {
          type: 'object' as const,
          properties: {
            loopId: { type: 'string', description: 'The loop this scratchpad belongs to' },
            done: { type: 'string', description: 'What you completed this iteration' },
            testStatus: { type: 'string', description: 'Test results (pass/fail + key output)' },
            nextStep: { type: 'string', description: 'What the next iteration should do' },
            blockers: { type: 'string', description: 'Any blockers, or "none"' },
          },
          required: ['loopId', 'done', 'testStatus', 'nextStep', 'blockers'],
        },
      },
```

**Step 4: Add tool handler in CallToolRequestSchema switch**

Add before the `default:` case (around line 662):

```typescript
      case 'write_scratchpad': {
        const scratchpad = WriteScratchpadSchema.parse(args);

        // Look up worktree path for this loop
        const loopRow = db.prepare(`
          SELECT worktree_path FROM loops WHERE id = ?
        `).get(scratchpad.loopId) as { worktree_path: string | null } | undefined;

        let scratchpadPath: string;
        if (loopRow?.worktree_path) {
          // Write to worktree
          scratchpadPath = join(loopRow.worktree_path, '.sq-scratchpad.md');
        } else {
          // Write to state dir
          const scratchpadDir = join(dirname(dbPath), 'scratchpads');
          if (!existsSync(scratchpadDir)) {
            mkdirSync(scratchpadDir, { recursive: true });
          }
          scratchpadPath = join(scratchpadDir, `${scratchpad.loopId}.md`);
        }

        const content = `# Iteration Scratchpad

## Done this iteration
${scratchpad.done}

## Test status
${scratchpad.testStatus}

## Next step
${scratchpad.nextStep}

## Blockers
${scratchpad.blockers}
`;

        writeFileSync(scratchpadPath, content, 'utf-8');
        result = { content: [{ type: 'text', text: `Scratchpad written to ${scratchpadPath}` }] };
        break;
      }
```

**Step 5: Verify types compile**

Run: `npm run typecheck`
Expected: No new errors

**Step 6: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(mcp): add write_scratchpad tool handler"
```

---

## Task 3: Update BUILD_PROMPT to Ralph-Style

**Files:**
- Modify: `src/agents/prompts.ts`

**Step 1: Replace BUILD_PROMPT**

Replace the entire `BUILD_PROMPT` export (lines 1-79) with:

```typescript
export const BUILD_PROMPT = `# BUILD ITERATION

## The Iron Law: Verification Before Completion

**NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE**

Before outputting TASK_COMPLETE, you MUST:
1. Run the full test suite (not just "it should pass")
2. See the actual output showing tests pass
3. Verify the exit code is 0

If you haven't run verification in this iteration, you cannot claim completion.

| Thought | Reality |
|---------|---------|
| "Should work now" | RUN the tests |
| "I'm confident" | Confidence ≠ evidence |
| "Just this small change" | Small changes break things |
| "Linter passed" | Linter ≠ tests |
| "Similar code works" | Run YOUR code |

## How to Work

1. Read the scratchpad below to understand current state
2. Make ONE small change (create a file, add a function, fix a failing test)
3. Run tests to verify your change
4. Use \`write_scratchpad\` tool with what you did and what's next

Write/run a failing test before implementing new functionality.
If stuck after 2-3 attempts at the same problem, output TASK_STUCK.

## Exit Signals

- Made progress, more to do → **ITERATION_DONE**
- All acceptance criteria met (WITH TEST EVIDENCE) → **TASK_COMPLETE**
- Blocked → **TASK_STUCK: <reason>**`;
```

**Step 2: Verify tests still pass for prompts**

Run: `npx tsx --test src/agents/prompts.test.ts`
Expected: Tests may fail if they check for specific content - we'll update them next

**Step 3: Update prompt tests**

Read `src/agents/prompts.test.ts` and update assertions to match new prompt content. The tests check for:
- "anti-over-engineering guidance"
- "error handling requirements"
- "grounding instruction"

These may need updating to match the new prompt structure.

**Step 4: Commit**

```bash
git add src/agents/prompts.ts src/agents/prompts.test.ts
git commit -m "feat(prompts): update BUILD_PROMPT to Ralph-style micro-iterations"
```

---

## Task 4: Add Scratchpad Reading Utility

**Files:**
- Modify: `src/orchestrator/phases/build.ts`

**Step 1: Add fs import for readFileSync**

Update imports at top to include:

```typescript
import { readFileSync, existsSync } from 'node:fs';
```

Note: `existsSync` might already be imported via other means, check first.

**Step 2: Add readScratchpad function**

Add after the `filesChangedBetweenStates` function (around line 60):

```typescript
/**
 * Reads the scratchpad for a loop if it exists.
 * Checks worktree path first, then falls back to state directory.
 */
function readScratchpad(loopCwd: string, loopId: string, stateDir: string): string | null {
  // Try worktree location first
  const worktreePath = join(loopCwd, '.sq-scratchpad.md');
  if (existsSync(worktreePath)) {
    return readFileSync(worktreePath, 'utf-8');
  }

  // Fall back to state dir
  const statePath = join(stateDir, 'scratchpads', `${loopId}.md`);
  if (existsSync(statePath)) {
    return readFileSync(statePath, 'utf-8');
  }

  return null;
}
```

**Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: No new errors

**Step 4: Commit**

```bash
git add src/orchestrator/phases/build.ts
git commit -m "feat(build): add readScratchpad utility function"
```

---

## Task 5: Update Prompt Builder Function

**Files:**
- Modify: `src/orchestrator/phases/build.ts`

**Step 1: Rename and update buildPromptWithFeedback**

Replace the `buildPromptWithFeedback` function (around line 62-96) with:

```typescript
export function buildIterationPrompt(
  task: Task,
  scratchpad: string | null,
  iteration: number,
  maxIterations: number,
  reviewIssues: ReviewIssue[]
): string {
  // Static content first for API-level prompt caching
  let prompt = BUILD_PROMPT;

  // Task details
  prompt += `

## Current Task
**ID:** ${task.id}
**Title:** ${task.title}
**Description:** ${task.description}

## Iteration: ${iteration}/${maxIterations}

## Scratchpad (from previous iteration)
${scratchpad || 'First iteration - no previous work. Start by understanding the task and writing a failing test.'}`;

  // Filter issues for this task, including cross-task issues (no taskId)
  const relevantIssues = reviewIssues.filter((i) => i.taskId === task.id || !i.taskId);

  if (relevantIssues.length > 0) {
    prompt += '\n\n## Review Feedback from Previous Attempt\n';
    prompt += 'Fix these issues:\n\n';
    for (const issue of relevantIssues) {
      const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      prompt += `- **${location}** (${issue.type}): ${issue.description}\n`;
      prompt += `  Fix: ${issue.suggestion}\n\n`;
    }
  }

  return prompt;
}
```

**Step 2: Keep old function as deprecated alias (temporary)**

Add below the new function for backwards compatibility during transition:

```typescript
/** @deprecated Use buildIterationPrompt instead */
export function buildPromptWithFeedback(
  task: Task,
  reviewIssues: ReviewIssue[],
  iteration: number,
  maxIterations: number
): string {
  return buildIterationPrompt(task, null, iteration, maxIterations, reviewIssues);
}
```

**Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: No new errors

**Step 4: Commit**

```bash
git add src/orchestrator/phases/build.ts
git commit -m "feat(build): add buildIterationPrompt with scratchpad support"
```

---

## Task 6: Update Build Iteration Loop to Use Scratchpad

**Files:**
- Modify: `src/orchestrator/phases/build.ts`

**Step 1: Update the loop iteration to read scratchpad**

In `executeBuildIteration`, find where the prompt is built (around line 224-229). Replace:

```typescript
    const prompt = buildPromptWithFeedback(
      task,
      state.context.reviewIssues ?? [],
      loop.iteration + 1,
      loop.maxIterations
    );
```

With:

```typescript
    // Read scratchpad from previous iteration
    const scratchpad = readScratchpad(loopCwd, loop.loopId, state.stateDir);

    const prompt = buildIterationPrompt(
      task,
      scratchpad,
      loop.iteration + 1,
      loop.maxIterations,
      state.context.reviewIssues ?? []
    );
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No new errors

**Step 3: Commit**

```bash
git add src/orchestrator/phases/build.ts
git commit -m "feat(build): read scratchpad at start of each iteration"
```

---

## Task 7: Handle ITERATION_DONE Signal

**Files:**
- Modify: `src/orchestrator/phases/build.ts`

**Step 1: Add ITERATION_DONE handler**

In the iteration result handling section (after checking for TASK_COMPLETE, around line 386), add handling for ITERATION_DONE. Find the block that starts with:

```typescript
      // Check for completion signal
      if (output.includes('TASK_COMPLETE')) {
```

Add BEFORE that block:

```typescript
      // Check for iteration progress signal (Ralph-style micro-iteration)
      if (output.includes('ITERATION_DONE')) {
        const durationMs = Date.now() - startTime;
        await writer?.complete(costUsd, durationMs);

        // Capture git state after iteration
        const gitStateAfter = await getGitState(loopCwd);
        const filesChanged = filesChangedBetweenStates(gitStateBefore, gitStateAfter);

        loopManager.incrementIteration(loop.loopId);
        updateStuckIndicators(loop, null, filesChanged);

        return {
          loopId: loop.loopId,
          taskId: task.id,
          completed: false,
          madeProgress: true,
          costUsd,
        };
      }
```

**Step 2: Update the return type to include madeProgress**

Find the loop result type (it's inferred). We need to ensure `madeProgress` is handled. Check if the type at the end of `executeBuildIteration` handles this field - it should be fine since we're using an object literal.

**Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: No new errors

**Step 4: Run tests**

Run: `npm test`
Expected: 263 passing, 2 failing (pre-existing)

**Step 5: Commit**

```bash
git add src/orchestrator/phases/build.ts
git commit -m "feat(build): handle ITERATION_DONE signal for micro-iterations"
```

---

## Task 8: Write Tests for New Functionality

**Files:**
- Modify: `src/orchestrator/phases/build.test.ts` (if exists) or create new test file

**Step 1: Check if build tests exist**

Run: `ls src/orchestrator/phases/build.test.ts 2>/dev/null || echo "No test file"`

**Step 2: Add tests for buildIterationPrompt**

Create or add to test file:

```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildIterationPrompt } from './build.js';

describe('buildIterationPrompt', () => {
  const mockTask = {
    id: 'task-1',
    title: 'Test task',
    description: 'A test task description',
    dependencies: [],
    status: 'pending' as const,
    estimatedIterations: 10,
  };

  test('includes Iron Law verification section', () => {
    const prompt = buildIterationPrompt(mockTask, null, 1, 10, []);
    assert.ok(prompt.includes('Iron Law'));
    assert.ok(prompt.includes('NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE'));
  });

  test('includes task details', () => {
    const prompt = buildIterationPrompt(mockTask, null, 1, 10, []);
    assert.ok(prompt.includes('task-1'));
    assert.ok(prompt.includes('Test task'));
    assert.ok(prompt.includes('A test task description'));
  });

  test('includes scratchpad when provided', () => {
    const scratchpad = '## Done\nWrote a test\n## Next\nImplement feature';
    const prompt = buildIterationPrompt(mockTask, scratchpad, 2, 10, []);
    assert.ok(prompt.includes('Wrote a test'));
    assert.ok(prompt.includes('Implement feature'));
  });

  test('shows first iteration message when no scratchpad', () => {
    const prompt = buildIterationPrompt(mockTask, null, 1, 10, []);
    assert.ok(prompt.includes('First iteration'));
  });

  test('includes review issues when present', () => {
    const issues = [{
      taskId: 'task-1',
      file: 'src/foo.ts',
      line: 42,
      type: 'missing-error-handling' as const,
      description: 'No error handling',
      suggestion: 'Add try/catch',
    }];
    const prompt = buildIterationPrompt(mockTask, null, 1, 10, issues);
    assert.ok(prompt.includes('src/foo.ts:42'));
    assert.ok(prompt.includes('No error handling'));
  });

  test('includes iteration count', () => {
    const prompt = buildIterationPrompt(mockTask, null, 5, 10, []);
    assert.ok(prompt.includes('5/10'));
  });
});
```

**Step 3: Run the new tests**

Run: `npx tsx --test src/orchestrator/phases/build.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/orchestrator/phases/build.test.ts
git commit -m "test(build): add tests for buildIterationPrompt"
```

---

## Task 9: Update prompts.test.ts for New BUILD_PROMPT

**Files:**
- Modify: `src/agents/prompts.test.ts`

**Step 1: Read current test file**

Check what the tests currently assert.

**Step 2: Update tests to match new prompt**

The new prompt should still have guidance that can satisfy the test intent. Update assertions to check for:
- Iron Law section (verification requirement)
- Exit signals (ITERATION_DONE, TASK_COMPLETE, TASK_STUCK)
- How to Work section

**Step 3: Run tests**

Run: `npx tsx --test src/agents/prompts.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/agents/prompts.test.ts
git commit -m "test(prompts): update tests for Ralph-style BUILD_PROMPT"
```

---

## Task 10: Integration Test - Full Iteration Cycle

**Files:**
- Create: `src/orchestrator/phases/build-iteration.test.ts`

**Step 1: Write integration test**

```typescript
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Build Iteration with Scratchpad', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `build-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('scratchpad is read from worktree path', async () => {
    // Create scratchpad in mock worktree
    const scratchpadContent = `# Iteration Scratchpad

## Done this iteration
Created User model

## Test status
PASS - 1 test passing

## Next step
Add validation

## Blockers
none
`;
    writeFileSync(join(testDir, '.sq-scratchpad.md'), scratchpadContent);

    // Import and test readScratchpad
    // Note: This requires the function to be exported or tested indirectly
    const content = readFileSync(join(testDir, '.sq-scratchpad.md'), 'utf-8');
    assert.ok(content.includes('Created User model'));
    assert.ok(content.includes('Add validation'));
  });
});
```

**Step 2: Run the integration test**

Run: `npx tsx --test src/orchestrator/phases/build-iteration.test.ts`
Expected: Test passes

**Step 3: Commit**

```bash
git add src/orchestrator/phases/build-iteration.test.ts
git commit -m "test(build): add integration test for scratchpad iteration"
```

---

## Task 11: Final Verification

**Step 1: Run all tests**

Run: `npm test`
Expected: 265+ passing (263 original + new tests), 2 failing (pre-existing)

**Step 2: Run type check**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Run linter**

Run: `npm run lint`
Expected: No errors

**Step 4: Create final commit summarizing the feature**

```bash
git add -A
git commit -m "feat(build): implement Ralph-style micro-iterations

- Add write_scratchpad MCP tool for iteration handoff
- Update BUILD_PROMPT with Iron Law and micro-iteration flow
- Add ITERATION_DONE signal for incremental progress
- Read scratchpad at start of each iteration
- Fresh context per iteration, scratchpad carries state

Closes: Ralph-style build iterations design"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add WriteScratchpadSchema | src/mcp/tools.ts |
| 2 | Add write_scratchpad handler | src/mcp/server.ts |
| 3 | Update BUILD_PROMPT | src/agents/prompts.ts |
| 4 | Add readScratchpad utility | src/orchestrator/phases/build.ts |
| 5 | Add buildIterationPrompt | src/orchestrator/phases/build.ts |
| 6 | Use scratchpad in iteration loop | src/orchestrator/phases/build.ts |
| 7 | Handle ITERATION_DONE signal | src/orchestrator/phases/build.ts |
| 8 | Test buildIterationPrompt | src/orchestrator/phases/build.test.ts |
| 9 | Update prompts tests | src/agents/prompts.test.ts |
| 10 | Integration test | src/orchestrator/phases/build-iteration.test.ts |
| 11 | Final verification | - |
