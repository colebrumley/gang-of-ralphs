import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createAgentConfig } from '../../agents/spawn.js';
import { type EffortConfig, getEffortConfig, getModelId } from '../../config/effort.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import type {
  LoopState,
  OrchestratorState,
  ReviewIssue,
  ReviewIssueType,
  ReviewType,
  Task,
} from '../../types/index.js';
import {
  type StreamEvent,
  isResultMessage,
  isStreamEventMessage,
  isToolProgressMessage,
} from '../../types/index.js';

export interface ReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
  suggestions: string[];
  costUsd: number;
  interpretedIntent?: string;
  intentSatisfied?: boolean;
}

/**
 * Load review results from database after agent has written them via MCP set_review_result.
 */
export function loadReviewResultFromDB(runId: string): {
  passed: boolean;
  issues: ReviewIssue[];
  interpretedIntent?: string;
  intentSatisfied?: boolean;
} {
  const db = getDatabase();

  // Load review issues
  const issueRows = db.prepare('SELECT * FROM review_issues WHERE run_id = ?').all(runId) as Array<{
    task_id: string;
    file: string;
    line: number | null;
    type: ReviewIssueType;
    description: string;
    suggestion: string;
  }>;

  const issues: ReviewIssue[] = issueRows.map((row) => ({
    taskId: row.task_id,
    file: row.file,
    line: row.line ?? undefined,
    type: row.type,
    description: row.description,
    suggestion: row.suggestion,
  }));

  // Load intent analysis from runs table
  const run = db
    .prepare('SELECT interpreted_intent, intent_satisfied FROM runs WHERE id = ?')
    .get(runId) as
    | {
        interpreted_intent: string | null;
        intent_satisfied: number | null;
      }
    | undefined;

  const interpretedIntent = run?.interpreted_intent ?? undefined;
  const intentSatisfied = run?.intent_satisfied != null ? run.intent_satisfied === 1 : undefined;

  // Review passes only if no issues AND intent is satisfied
  // If intentSatisfied is undefined (not set), fall back to just checking issues
  const passed = issues.length === 0 && (intentSatisfied ?? true);

  return { passed, issues, interpretedIntent, intentSatisfied };
}

/**
 * Review prompt for ENUMERATE phase - reviewing tasks before planning.
 * Checks if tasks are well-defined, complete, and aligned with spec intent.
 */
function getEnumerateReviewPrompt(depth: EffortConfig['reviewDepth']): string {
  const mcpInstructions = `
## How to Report Results
Use the \`set_review_result\` MCP tool when you finish reviewing.

**Required fields:**
- \`interpretedIntent\`: In 1-2 sentences, what was the user actually trying to accomplish?
- \`intentSatisfied\`: Do the enumerated tasks, if completed, satisfy this intent?
- \`passed\`: Are the tasks well-defined and complete?
- \`issues\`: Array of specific issues found

For a passing review:
\`\`\`
set_review_result({
  interpretedIntent: "User wants to add authentication so users can log in and maintain sessions",
  intentSatisfied: true,
  passed: true,
  issues: []
})
\`\`\`

For a failing review:
\`\`\`
set_review_result({
  interpretedIntent: "User wants comprehensive error handling throughout the app",
  intentSatisfied: false,
  passed: false,
  issues: [
    {
      taskId: "general",
      file: "spec",
      type: "spec-intent-mismatch",
      description: "Tasks only cover happy path - no tasks for error states or edge cases",
      suggestion: "Add tasks for: validation errors, network failures, empty states"
    }
  ]
})
\`\`\`

Issue types: spec-intent-mismatch, missing-error-handling, over-engineering`;

  const baseChecks = `
**Check for these issues:**
- Missing tasks: Are there requirements in the spec not covered by any task?
- Vague tasks: Are task descriptions specific enough to implement?
- Scope creep: Are there tasks that go beyond what the spec requests?
- Missing edge cases: Does the spec imply error handling or edge cases not captured?`;

  switch (depth) {
    case 'shallow':
      return `# ENUMERATE REVIEW PHASE

You are reviewing the **enumerated tasks** before planning begins.

${mcpInstructions}

Perform a basic review:
- Do the tasks cover the main requirements from the spec?
- Are there obvious gaps?

When done, output: REVIEW_COMPLETE`;

    case 'standard':
      return `# ENUMERATE REVIEW PHASE

You are reviewing the **enumerated tasks** before planning begins.

${mcpInstructions}
${baseChecks}

Perform a standard review:
- Do tasks cover all spec requirements?
- Are task descriptions clear and actionable?
- Are there gaps or missing edge cases?

When done, output: REVIEW_COMPLETE`;

    case 'deep':
    case 'comprehensive':
      return `# ENUMERATE REVIEW PHASE

You are reviewing the **enumerated tasks** before planning begins.

${mcpInstructions}
${baseChecks}

Perform a comprehensive review:
- Full spec coverage analysis
- Task clarity and actionability
- Edge case coverage
- Appropriate task granularity (not too big, not too small)
- Dependencies that might be missing

When done, output: REVIEW_COMPLETE`;
  }
}

/**
 * Review prompt for PLAN phase - reviewing execution order before building.
 * Checks if dependencies are correct and parallelization is appropriate.
 */
function getPlanReviewPrompt(depth: EffortConfig['reviewDepth']): string {
  const mcpInstructions = `
## How to Report Results
Use the \`set_review_result\` MCP tool when you finish reviewing.

**Required fields:**
- \`interpretedIntent\`: In 1-2 sentences, what is the user trying to build?
- \`intentSatisfied\`: Does the execution plan lead toward satisfying this intent?
- \`passed\`: Is the plan logical and dependencies correct?
- \`issues\`: Array of specific issues found

For a passing review:
\`\`\`
set_review_result({
  interpretedIntent: "User wants a working authentication system with login, logout, and session management",
  intentSatisfied: true,
  passed: true,
  issues: []
})
\`\`\`

For a failing review:
\`\`\`
set_review_result({
  interpretedIntent: "User wants database migrations before API endpoints",
  intentSatisfied: false,
  passed: false,
  issues: [
    {
      taskId: "task-3",
      file: "plan",
      type: "pattern-violation",
      description: "API endpoint task scheduled before database schema task it depends on",
      suggestion: "Move database schema task to an earlier parallel group"
    }
  ]
})
\`\`\`

Issue types: pattern-violation, over-engineering, spec-intent-mismatch`;

  const baseChecks = `
**Check for these issues:**
- Dependency errors: Are tasks scheduled before their dependencies?
- Incorrect parallelization: Are tasks that depend on each other in the same parallel group?
- Missing dependencies: Are there implicit dependencies not captured?
- Inefficient ordering: Could the plan be more parallel without breaking dependencies?`;

  switch (depth) {
    case 'shallow':
      return `# PLAN REVIEW PHASE

You are reviewing the **execution plan** before building begins.

The plan shows which tasks run in parallel groups and their execution order.

${mcpInstructions}

Perform a basic review:
- Are there obvious dependency violations?
- Does the order make sense?

When done, output: REVIEW_COMPLETE`;

    case 'standard':
      return `# PLAN REVIEW PHASE

You are reviewing the **execution plan** before building begins.

The plan shows which tasks run in parallel groups and their execution order.

${mcpInstructions}
${baseChecks}

Perform a standard review:
- Are dependencies correctly ordered?
- Is parallelization appropriate?
- Are there tasks that should run earlier or later?

When done, output: REVIEW_COMPLETE`;

    case 'deep':
    case 'comprehensive':
      return `# PLAN REVIEW PHASE

You are reviewing the **execution plan** before building begins.

The plan shows which tasks run in parallel groups and their execution order.

${mcpInstructions}
${baseChecks}

Perform a comprehensive review:
- Full dependency analysis
- Parallelization optimization
- Risk assessment (which tasks are most likely to fail?)
- Critical path identification
- Potential merge conflict risks between parallel tasks

When done, output: REVIEW_COMPLETE`;
  }
}

export function getReviewPrompt(
  depth: EffortConfig['reviewDepth'],
  reviewType: 'enumerate' | 'plan' | 'build'
): string {
  // For enumerate and plan reviews, use specialized prompts
  if (reviewType === 'enumerate') {
    return getEnumerateReviewPrompt(depth);
  }
  if (reviewType === 'plan') {
    return getPlanReviewPrompt(depth);
  }

  // Build review - the full code review prompt
  const intentAnalysis = `
## Intent Analysis (Do This First)

Before examining implementation details, step back and consider the spec holistically:

1. **What was the user trying to accomplish?** Not just what they asked for literally, but what goal they're pursuing. A request to "add a login button" is really about enabling user authentication.

2. **What would a reasonable user expect?** Even if not stated, what adjacent requirements would be natural? Error messages, edge case handling, consistent UX patterns, etc.

3. **Does the implementation serve the goal?** Code can satisfy literal requirements while missing the point entirely. A login button that exists but is hidden, or works but has no error feedback, technically meets the spec but fails the user.

Write down your interpretation before reviewing code. This prevents rationalization.`;

  const mcpInstructions = `
## How to Report Results
Use the \`set_review_result\` MCP tool when you finish reviewing.

**Required fields:**
- \`interpretedIntent\`: In 1-2 sentences, what was the user actually trying to accomplish? What unstated expectations would be reasonable?
- \`intentSatisfied\`: Does the implementation serve this interpreted intent, not just the literal words?
- \`passed\`: Did the implementation pass technical review (tests, bugs, code quality)?
- \`issues\`: Array of specific issues found

**Important:** Both \`passed\` AND \`intentSatisfied\` must be true for the review to pass. Code that works but misses the point should fail.

For a passing review:
\`\`\`
set_review_result({
  interpretedIntent: "User wants to enable authentication so users can have persistent accounts and personalized experiences",
  intentSatisfied: true,
  passed: true,
  issues: []
})
\`\`\`

For a failing review (intent not satisfied):
\`\`\`
set_review_result({
  interpretedIntent: "User wants error messages to help users understand and fix problems",
  intentSatisfied: false,
  passed: true,
  issues: [
    {
      taskId: "task-5",
      file: "src/components/Form.tsx",
      line: 89,
      type: "spec-intent-mismatch",
      description: "Error messages are technical (e.g., 'VALIDATION_ERR_422') rather than user-friendly",
      suggestion: "Replace error codes with human-readable messages like 'Please enter a valid email address'"
    }
  ]
})
\`\`\`

Issue types: over-engineering, missing-error-handling, pattern-violation, dead-code, spec-intent-mismatch`;

  const verificationRequirement = `
## The Iron Law: Evidence Before Claims

**NO REVIEW CLAIMS WITHOUT VERIFICATION EVIDENCE**

Before calling set_review_result, you MUST:
1. Actually RUN the test suite and show output
2. Actually READ the implementation files
3. Show evidence before making any claim

| Claim | Requires | NOT Sufficient |
|-------|----------|----------------|
| "Tests pass" | Test command output: 0 failures | "Should pass", previous run, assumption |
| "Code correct" | Read actual file contents | Task description, memory |
| "Spec satisfied" | Line-by-line requirement check | "Looks complete" |
| "No issues" | Explicit verification of each area | Absence of obvious problems |

**Red Flags - You're Rationalizing If You Think:**
- "I'm confident the tests pass" → RUN THEM
- "The code looks fine" → READ IT
- "This should work" → VERIFY IT`;

  const qualityChecks = `
**Check for these quality issues:**
- Unnecessary abstractions: classes/functions used only once, premature generalization
- Missing error handling: unhandled promise rejections, unchecked file/network operations, no input validation at boundaries
- Pattern violations: code that doesn't match existing codebase conventions
- Dead code: unused imports, unreachable branches, commented-out code

For each issue, specify the file, line number, what's wrong, and how to fix it.`;

  switch (depth) {
    case 'shallow':
      return `# REVIEW PHASE

You are in the **REVIEW** phase. Evaluate the work done so far.
${intentAnalysis}
${verificationRequirement}
${mcpInstructions}

Perform a basic review:
- Do tests pass? (RUN them, show output)
- Are there obvious bugs?

When done, output: REVIEW_COMPLETE`;

    case 'standard':
      return `# REVIEW PHASE

You are in the **REVIEW** phase. Evaluate the work done so far.
${intentAnalysis}
${verificationRequirement}
${mcpInstructions}
${qualityChecks}

Perform a standard review:
- Do tests pass? (RUN them, show output)
- Does the code match the spec? (READ files, check each requirement)
- Are there bugs or edge cases?

When done, output: REVIEW_COMPLETE`;

    case 'deep':
      return `# REVIEW PHASE

You are in the **REVIEW** phase. Evaluate the work done so far.
${intentAnalysis}
${verificationRequirement}
${mcpInstructions}
${qualityChecks}

Perform a comprehensive review:
- Do tests pass? (RUN them, show output)
- Does implementation match spec? (READ files, verify each requirement)
- Are edge cases handled?
- Is error handling adequate?
- Is the approach optimal?

When done, output: REVIEW_COMPLETE`;

    case 'comprehensive':
      return `# REVIEW PHASE

You are in the **REVIEW** phase. Evaluate the work done so far.
${intentAnalysis}
${verificationRequirement}
${mcpInstructions}
${qualityChecks}

Perform an exhaustive review:
- Do all tests pass? (RUN full suite, show output)
- Full spec compliance check (READ each file, verify each requirement)
- Security analysis
- Performance analysis
- Edge case coverage
- Code quality assessment
- Documentation completeness

When done, output: REVIEW_COMPLETE`;
  }
}

export async function executeReview(
  state: OrchestratorState,
  reviewType: ReviewType,
  depth: EffortConfig['reviewDepth'],
  onOutput?: (text: string) => void,
  tracer?: DebugTracer
): Promise<ReviewResult> {
  const dbPath = join(state.stateDir, 'state.db');
  const cwd = process.cwd();
  const effortConfig = getEffortConfig(state.effort);
  const model = getModelId(effortConfig.models.review);
  const config = createAgentConfig('review', cwd, state.runId, dbPath, model);

  let context = '';
  switch (reviewType) {
    case 'enumerate':
      context = `Review the enumerated tasks:\n${JSON.stringify(state.tasks, null, 2)}`;
      break;
    case 'plan':
      context = `Review the execution plan:\n${JSON.stringify(state.taskGraph, null, 2)}`;
      break;
    case 'build': {
      const taskDetails = state.completedTasks
        .map((id) => {
          const task = state.tasks.find((t) => t.id === id);
          return task ? `- ${id}: ${task.title}\n  ${task.description}` : `- ${id}`;
        })
        .join('\n');
      context = `Review the completed work.\n\nCompleted tasks:\n${taskDetails}\n\nUse the Read and Glob tools to verify the implementation files exist and are correct.`;
      break;
    }
  }

  // reviewType is validated by switch above; default to 'build' if somehow null
  const effectiveReviewType = reviewType ?? 'build';
  const prompt = `${getReviewPrompt(depth, effectiveReviewType)}

## Context:
${context}

## Spec:
File: ${state.specPath}`;

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  const writer = tracer?.startAgentCall({
    phase: 'review',
    prompt,
  });

  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      model: config.model,
      includePartialMessages: true,
      mcpServers: {
        'sq-db': {
          command: 'node',
          args: [MCP_SERVER_PATH, state.runId, dbPath],
        },
      },
    },
  })) {
    // Handle tool progress messages to show activity during tool execution
    if (isToolProgressMessage(message)) {
      const toolName = message.tool_name || 'tool';
      const elapsed = message.elapsed_time_seconds || 0;
      const progressText = `[tool] ${toolName} (${elapsed.toFixed(1)}s)\n`;
      writer?.appendOutput(progressText);
      onOutput?.(progressText);
    }
    // Handle streaming events for real-time thinking output
    if (isStreamEventMessage(message)) {
      const event = message.event as StreamEvent;
      // Handle tool_use content block start to show when a tool begins
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const toolName = event.content_block.name || 'tool';
        const toolText = `[tool] starting ${toolName}\n`;
        writer?.appendOutput(toolText);
        onOutput?.(toolText);
      }
      // Handle thinking delta events
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const thinkingText = event.delta.thinking || '';
        if (thinkingText) {
          writer?.appendOutput(thinkingText);
          onOutput?.(`[thinking] ${thinkingText}`);
        }
      }
      // Handle text delta events
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const textDelta = event.delta.text || '';
        if (textDelta) {
          fullOutput += textDelta;
          writer?.appendOutput(textDelta);
          onOutput?.(textDelta);
        }
      }
    }
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        // Only handle text blocks that weren't already streamed
        if ('text' in block && !fullOutput.includes(block.text)) {
          fullOutput += block.text;
          writer?.appendOutput(block.text);
          onOutput?.(block.text);
        }
        // Capture thinking blocks to show activity during extended thinking
        if (
          'type' in block &&
          block.type === 'thinking' &&
          'thinking' in block &&
          typeof block.thinking === 'string'
        ) {
          const thinkingText = `[thinking] ${block.thinking}\n`;
          writer?.appendOutput(thinkingText);
          onOutput?.(thinkingText);
        }
      }
    }
    if (isResultMessage(message)) {
      costUsd = message.total_cost_usd || 0;
    }
  }

  const durationMs = Date.now() - startTime;
  await writer?.complete(costUsd, durationMs);

  // Review result is now in the database via MCP set_review_result call
  const { passed, issues, interpretedIntent, intentSatisfied } = loadReviewResultFromDB(
    state.runId
  );

  return {
    passed,
    issues,
    suggestions: [],
    costUsd,
    interpretedIntent,
    intentSatisfied,
  };
}

// ============================================================================
// Loop Review Functions
// ============================================================================

export interface LoopReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
  costUsd: number;
  reviewId: string;
  interpretedIntent?: string;
  intentSatisfied?: boolean;
}

/**
 * Load the most recent loop review result from the database.
 */
export function loadLoopReviewResultFromDB(
  runId: string,
  loopId: string
): {
  reviewId: string | null;
  passed: boolean;
  issues: ReviewIssue[];
  interpretedIntent?: string;
  intentSatisfied?: boolean;
} {
  const db = getDatabase();

  // Get the most recent loop review for this loop
  const review = db
    .prepare(
      `SELECT id, passed, interpreted_intent, intent_satisfied
       FROM loop_reviews
       WHERE run_id = ? AND loop_id = ?
       ORDER BY reviewed_at DESC
       LIMIT 1`
    )
    .get(runId, loopId) as
    | {
        id: string;
        passed: number;
        interpreted_intent: string | null;
        intent_satisfied: number | null;
      }
    | undefined;

  if (!review) {
    return { reviewId: null, passed: false, issues: [] };
  }

  // Load issues for this loop review
  const issueRows = db
    .prepare(
      `SELECT task_id, file, line, type, description, suggestion
       FROM review_issues
       WHERE loop_review_id = ?`
    )
    .all(review.id) as Array<{
    task_id: string;
    file: string;
    line: number | null;
    type: ReviewIssueType;
    description: string;
    suggestion: string;
  }>;

  const issues: ReviewIssue[] = issueRows.map((row) => ({
    taskId: row.task_id,
    file: row.file,
    line: row.line ?? undefined,
    type: row.type,
    description: row.description,
    suggestion: row.suggestion,
  }));

  return {
    reviewId: review.id,
    passed: review.passed === 1,
    issues,
    interpretedIntent: review.interpreted_intent ?? undefined,
    intentSatisfied: review.intent_satisfied != null ? review.intent_satisfied === 1 : undefined,
  };
}

/**
 * Generate the review prompt for a specific loop.
 * @param isCheckpoint - If true, this is an interim checkpoint review, not a task completion review
 */
export function getLoopReviewPrompt(
  loop: LoopState,
  task: Task,
  otherLoopsSummary: string,
  depth: EffortConfig['reviewDepth'],
  isCheckpoint = false
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
  loopId: "${loop.loopId}",
  taskId: "${task.id}",
  passed: true/false,
  interpretedIntent: "What the task was really trying to accomplish",
  intentSatisfied: true/false,
  issues: [{ file, line, type, description, suggestion }]
})
\`\`\`

Issue types: over-engineering, missing-error-handling, pattern-violation, dead-code, spec-intent-mismatch`;

  const workingDir = loop.worktreePath
    ? `This loop's worktree: ${loop.worktreePath}`
    : 'Working in main repository';

  // Adjust content based on depth
  let depthContent = '';
  switch (depth) {
    case 'shallow':
      depthContent = `
Perform a basic review:
- Do tests pass? (RUN them, show output)
- Are there obvious bugs?`;
      break;
    case 'standard':
      depthContent = `
Perform a standard review:
- Do tests pass? (RUN them, show output)
- Does the code match the task requirements? (READ files, check each requirement)
- Are there bugs or edge cases?

${qualityChecks}`;
      break;
    case 'deep':
      depthContent = `
Perform a comprehensive review:
- Do tests pass? (RUN them, show output)
- Does implementation match task? (READ files, verify each requirement)
- Are edge cases handled?
- Is error handling adequate?

${qualityChecks}`;
      break;
    case 'comprehensive':
      depthContent = `
Perform an exhaustive review:
- Do all tests pass? (RUN full suite, show output)
- Full task compliance check (READ each file, verify each requirement)
- Security analysis
- Performance analysis
- Edge case coverage
- Code quality assessment

${qualityChecks}`;
      break;
  }

  const reviewType = isCheckpoint ? 'CHECKPOINT REVIEW' : 'LOOP REVIEW';
  const reviewDescription = isCheckpoint
    ? `This is an interim checkpoint review at iteration ${loop.iteration}. The task is NOT yet complete - check progress and catch issues early.`
    : `You are reviewing work completed by Loop ${loop.loopId}.`;

  const checkpointNote = isCheckpoint
    ? `
## Checkpoint Review Note
This is a progress check, not a completion review. Focus on:
- Are we on the right track?
- Are there any issues or bugs introduced so far?
- Is the approach sound?

The agent will continue working after this review. Don't fail the review just because the task isn't finished yet.`
    : '';

  return `# ${reviewType} PHASE

${reviewDescription}

## Task Under Review
**${task.title}**
${task.description}

## Current Progress
Iteration: ${loop.iteration}/${loop.maxIterations}
${checkpointNote}

## Other Loops (for context)
${otherLoopsSummary || 'No other active loops'}

## Working Directory
${workingDir}

${intentAnalysis}
${verificationRequirement}
${depthContent}
${mcpInstructions}

When done, output: REVIEW_COMPLETE`;
}

/**
 * Execute a review for a specific loop.
 * @param isCheckpoint - If true, this is an interim checkpoint review, not a task completion review
 */
export async function executeLoopReview(
  state: OrchestratorState,
  loop: LoopState,
  task: Task,
  otherLoopsSummary: string,
  onOutput?: (text: string) => void,
  tracer?: DebugTracer,
  isCheckpoint = false
): Promise<LoopReviewResult> {
  const dbPath = join(state.stateDir, 'state.db');
  const effortConfig = getEffortConfig(state.effort);
  const model = getModelId(effortConfig.models.review);

  // Use worktree path if available
  const cwd = loop.worktreePath || process.cwd();
  const config = createAgentConfig('review', cwd, state.runId, dbPath, model);

  const prompt = `${getLoopReviewPrompt(loop, task, otherLoopsSummary, effortConfig.reviewDepth, isCheckpoint)}

## Spec:
File: ${state.specPath}`;

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  const writer = tracer?.startAgentCall({
    phase: 'review',
    loopId: loop.loopId,
    prompt,
  });

  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      model: config.model,
      includePartialMessages: true,
      mcpServers: {
        'sq-db': {
          command: 'node',
          args: [MCP_SERVER_PATH, state.runId, dbPath],
        },
      },
    },
  })) {
    // Handle tool progress messages
    if (isToolProgressMessage(message)) {
      const toolName = message.tool_name || 'tool';
      const elapsed = message.elapsed_time_seconds || 0;
      const progressText = `[tool] ${toolName} (${elapsed.toFixed(1)}s)\n`;
      writer?.appendOutput(progressText);
      onOutput?.(progressText);
    }
    // Handle streaming events
    if (isStreamEventMessage(message)) {
      const event = message.event as StreamEvent;
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const toolName = event.content_block.name || 'tool';
        const toolText = `[tool] starting ${toolName}\n`;
        writer?.appendOutput(toolText);
        onOutput?.(toolText);
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const thinkingText = event.delta.thinking || '';
        if (thinkingText) {
          writer?.appendOutput(thinkingText);
          onOutput?.(`[thinking] ${thinkingText}`);
        }
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const textDelta = event.delta.text || '';
        if (textDelta) {
          fullOutput += textDelta;
          writer?.appendOutput(textDelta);
          onOutput?.(textDelta);
        }
      }
    }
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block && !fullOutput.includes(block.text)) {
          fullOutput += block.text;
          writer?.appendOutput(block.text);
          onOutput?.(block.text);
        }
        if (
          'type' in block &&
          block.type === 'thinking' &&
          'thinking' in block &&
          typeof block.thinking === 'string'
        ) {
          const thinkingText = `[thinking] ${block.thinking}\n`;
          writer?.appendOutput(thinkingText);
          onOutput?.(thinkingText);
        }
      }
    }
    if (isResultMessage(message)) {
      costUsd = message.total_cost_usd || 0;
    }
  }

  const durationMs = Date.now() - startTime;
  await writer?.complete(costUsd, durationMs);

  // Load review result from database
  const { reviewId, passed, issues, interpretedIntent, intentSatisfied } =
    loadLoopReviewResultFromDB(state.runId, loop.loopId);

  return {
    passed,
    issues,
    costUsd,
    reviewId: reviewId || '',
    interpretedIntent,
    intentSatisfied,
  };
}
