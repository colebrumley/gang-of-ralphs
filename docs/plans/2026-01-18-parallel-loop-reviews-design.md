# Parallel Loop Reviews Design

## Overview

Each loop gets its own review agent running in parallel, providing faster feedback, isolated evaluation, and incremental issue detection.

**Key behaviors**:
- Reviews trigger immediately when a loop completes its task (always)
- Higher effort levels add interval checkpoint reviews as additional safety net
- Failed loops block until review passes; other loops continue; sync at group end

## Database Schema Changes

### New `loop_reviews` table

```sql
CREATE TABLE loop_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  loop_id TEXT NOT NULL,
  task_id TEXT,                    -- which task was reviewed (null for checkpoint reviews)
  passed INTEGER NOT NULL,         -- 0 or 1
  interpreted_intent TEXT,
  intent_satisfied INTEGER,        -- 0, 1, or null
  reviewed_at TEXT NOT NULL,       -- ISO timestamp
  cost_usd REAL DEFAULT 0,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (loop_id) REFERENCES loops(id)
);
```

### Modify `review_issues` table

```sql
ALTER TABLE review_issues ADD COLUMN loop_id TEXT;
ALTER TABLE review_issues ADD COLUMN loop_review_id TEXT;
```

Existing run-level reviews (enumerate, plan) continue writing with `loop_id = NULL`. Loop reviews populate both fields.

## MCP Tool Changes

### New `set_loop_review_result` tool

```typescript
{
  name: 'set_loop_review_result',
  description: 'Report review results for a specific loop',
  inputSchema: {
    type: 'object',
    properties: {
      loopId: { type: 'string', description: 'The loop being reviewed' },
      taskId: { type: 'string', description: 'The task that was reviewed (optional for checkpoint reviews)' },
      passed: { type: 'boolean' },
      interpretedIntent: { type: 'string' },
      intentSatisfied: { type: 'boolean' },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'number' },
            type: { type: 'string' },
            description: { type: 'string' },
            suggestion: { type: 'string' }
          }
        }
      }
    },
    required: ['loopId', 'passed']
  }
}
```

The existing `set_review_result` tool remains unchanged for enumerate and plan reviews.

## Execution Flow

### Build phase changes

Current flow per loop:
```
task assignment → agent works → task complete → next iteration
```

New flow per loop:
```
task assignment → agent works → task complete → review agent → passed?
                                                    ↓           ↓
                                                   no          yes
                                                    ↓           ↓
                                              block loop    next iteration
                                              enter REVISE
```

### Parallel execution

```typescript
// Simplified logic
const loopPromises = activeLoops.map(async (loop) => {
  const buildResult = await runBuildAgent(loop);

  if (buildResult.taskCompleted) {
    const reviewResult = await runLoopReview(loop, buildResult.taskId);

    if (!reviewResult.passed) {
      loop.status = 'needs_revision';
      loop.reviewFeedback = reviewResult.issues;
      return { loop, needsRevision: true };
    }
  }

  return { loop, needsRevision: false };
});

const results = await Promise.all(loopPromises);
```

Each loop's build + review runs as a unit. All loops execute in parallel.

## Loop State and Revision Handling

### Changes to `LoopState` type

```typescript
interface LoopState {
  // existing fields...
  id: string;
  status: LoopStatus;
  iteration: number;

  // new fields
  reviewStatus: 'pending' | 'in_progress' | 'passed' | 'failed';
  lastReviewId: string | null;      // references loop_reviews.id
  revisionAttempts: number;         // count of revision attempts for current task
}
```

### Revision flow for failed loops

1. Loop completes task → review fails → `reviewStatus = 'failed'`
2. Loop enters revision: re-runs build agent with review feedback injected into prompt
3. After revision attempt → review again
4. If still failing after `maxRevisionAttempts` (from effort config) → mark loop as stuck

### Sync at group end

```typescript
// After all loops finish their tasks
const allLoopsPassed = results.every(r => r.loop.reviewStatus === 'passed');

if (allLoopsPassed) {
  // Merge all worktrees, move to next parallel group
} else {
  // Wait for stuck loops to be resolved or mark group as blocked
}
```

## Effort Level Configuration

| Level | Review on Task Complete | Checkpoint Reviews | Max Revision Attempts |
|-------|------------------------|--------------------|-----------------------|
| low | Yes | No | 2 |
| medium | Yes | Every 5 iterations | 3 |
| high | Yes | Every 3 iterations | 4 |
| max | Yes | Every iteration | 5 |

### Checkpoint reviews (higher effort levels)

When any loop hits the iteration threshold, all active loops get a parallel review simultaneously—even if they haven't completed a task yet. This catches loops that are spinning without making progress.

```typescript
// In LoopManager
needsCheckpointReview(): boolean {
  if (!this.effortConfig.checkpointReviewInterval) return false;

  return this.getActiveLoops().some(loop =>
    loop.iteration - loop.lastCheckpointReviewAt >= this.effortConfig.checkpointReviewInterval
  );
}
```

## Review Prompt and Context

### Per-loop review prompt

```typescript
function getLoopReviewPrompt(
  loop: LoopState,
  task: Task,
  otherLoopsSummary: string,
  depth: EffortConfig['reviewDepth']
): string {
  const intentAnalysis = `
## Intent Analysis (Do This First)

Before examining implementation details, step back:

1. **What was this task trying to accomplish?** Not just literally, but what goal it serves.
2. **What would a reasonable user expect?** Error handling, edge cases, consistent patterns.
3. **Does the implementation serve the goal?** Code can satisfy literal requirements while missing the point.

Write down your interpretation before reviewing code. This prevents rationalization.`;

  const verificationRequirement = `
## The Iron Law: Evidence Before Claims

**NO REVIEW CLAIMS WITHOUT VERIFICATION EVIDENCE**

Before calling set_loop_review_result, you MUST:
1. Actually RUN relevant tests and show output
2. Actually READ the implementation files
3. Show evidence before making any claim

| Claim | Requires | NOT Sufficient |
|-------|----------|----------------|
| "Tests pass" | Test command output | "Should pass", assumption |
| "Code correct" | Read actual file contents | Task description, memory |
| "Task satisfied" | Line-by-line check | "Looks complete" |`;

  const qualityChecks = `
## Quality Checks

- Unnecessary abstractions: classes/functions used only once
- Missing error handling: unhandled rejections, unchecked operations
- Pattern violations: code that doesn't match codebase conventions
- Dead code: unused imports, unreachable branches`;

  const mcpInstructions = `
## How to Report Results

Use \`set_loop_review_result\` when finished:

\`\`\`
set_loop_review_result({
  loopId: "${loop.id}",
  taskId: "${task.id}",
  passed: true/false,
  interpretedIntent: "What the task was really trying to accomplish",
  intentSatisfied: true/false,
  issues: [{ file, line, type, description, suggestion }]
})
\`\`\`

Issue types: over-engineering, missing-error-handling, pattern-violation, dead-code, spec-intent-mismatch`;

  return `# LOOP REVIEW PHASE

You are reviewing work completed by Loop ${loop.id}.

## Task Under Review
**${task.title}**
${task.description}

## Other Loops (for context)
${otherLoopsSummary}

## Working Directory
This loop's worktree: ${loop.worktreePath}

${intentAnalysis}
${verificationRequirement}
${qualityChecks}
${mcpInstructions}

When done, output: REVIEW_COMPLETE`;
}
```

Depth variations (shallow/standard/deep/comprehensive) adjust which sections are included, matching the existing pattern in `getReviewPrompt()`.

### Other loops summary

Generated by `LoopManager.getOtherLoopsSummary(excludeLoopId)`:

```
- Loop A (completed): Implemented user authentication endpoints
- Loop C (in_progress): Working on database migrations, iteration 3
```

Brief context without full details—just enough to spot obvious conflicts.

## Files to Modify

| File | Changes |
|------|---------|
| `src/db/schema.ts` | Add `loop_reviews` table, add `loop_id`/`loop_review_id` columns to `review_issues` |
| `src/types/index.ts` | Add `reviewStatus`, `lastReviewId`, `revisionAttempts` to `LoopState` |
| `src/mcp/tools.ts` | Add `set_loop_review_result` tool |
| `src/orchestrator/phases/review.ts` | Add `executeLoopReview()`, `getLoopReviewPrompt()`, `loadLoopReviewResultFromDB()` |
| `src/orchestrator/phases/build.ts` | Integrate per-loop review after task completion |
| `src/loops/manager.ts` | Add `getOtherLoopsSummary()`, `needsCheckpointReview()`, track `reviewStatus` |
| `src/config/effort.ts` | Add `checkpointReviewInterval`, `maxRevisionAttempts` per effort level |
| `src/state/init.ts` | Initialize new loop state fields |
