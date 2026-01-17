import { join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createAgentConfig } from '../../agents/spawn.js';
import type { EffortConfig } from '../../config/effort.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import type {
  OrchestratorState,
  ReviewIssue,
  ReviewIssueType,
  ReviewType,
} from '../../types/index.js';

export interface ReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
  suggestions: string[];
  costUsd: number;
}

/**
 * Load review results from database after agent has written them via MCP set_review_result.
 */
export function loadReviewResultFromDB(runId: string): { passed: boolean; issues: ReviewIssue[] } {
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

  // Check if review passed (no issues = passed)
  // The set_review_result MCP tool clears pending_review, so we check issues
  const passed = issues.length === 0;

  return { passed, issues };
}

export function getReviewPrompt(depth: EffortConfig['reviewDepth']): string {
  const mcpInstructions = `
## How to Report Results
Use the \`set_review_result\` MCP tool when you finish reviewing.

For a passing review:
\`\`\`
set_review_result({ passed: true, issues: [] })
\`\`\`

For a failing review with issues:
\`\`\`
set_review_result({
  passed: false,
  issues: [
    {
      taskId: "task-3",
      file: "src/models/User.ts",
      line: 42,
      type: "missing-error-handling",
      description: "Database query can throw but error is not caught",
      suggestion: "Wrap in try/catch and return appropriate error response"
    }
  ]
})
\`\`\`

Issue types: over-engineering, missing-error-handling, pattern-violation, dead-code`;

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
${mcpInstructions}

Perform a basic review:
- Do tests pass?
- Are there obvious bugs?

When done, output: REVIEW_COMPLETE`;

    case 'standard':
      return `# REVIEW PHASE

You are in the **REVIEW** phase. Evaluate the work done so far.
${mcpInstructions}
${qualityChecks}

Perform a standard review:
- Do tests pass?
- Does the code match the spec?
- Are there bugs or edge cases?

When done, output: REVIEW_COMPLETE`;

    case 'deep':
      return `# REVIEW PHASE

You are in the **REVIEW** phase. Evaluate the work done so far.
${mcpInstructions}
${qualityChecks}

Perform a comprehensive review:
- Do tests pass?
- Does implementation match spec?
- Are edge cases handled?
- Is error handling adequate?
- Is the approach optimal?

When done, output: REVIEW_COMPLETE`;

    case 'comprehensive':
      return `# REVIEW PHASE

You are in the **REVIEW** phase. Evaluate the work done so far.
${mcpInstructions}
${qualityChecks}

Perform an exhaustive review:
- Do all tests pass?
- Full spec compliance check
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
  const config = createAgentConfig('review', cwd, state.runId, dbPath);

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

  const prompt = `${getReviewPrompt(depth)}

## Context:
${context}

## Spec:
File: ${state.specPath}`;

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      mcpServers: {
        'sq-db': {
          command: 'node',
          args: [resolve(cwd, 'node_modules/.bin/sq-mcp'), state.runId, dbPath],
        },
      },
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
    if (message.type === 'result') {
      costUsd = (message as any).total_cost_usd || 0;
    }
  }

  const durationMs = Date.now() - startTime;

  await tracer?.logAgentCall({
    phase: 'review',
    prompt,
    response: fullOutput,
    costUsd,
    durationMs,
  });

  // Review result is now in the database via MCP set_review_result call
  const { passed, issues } = loadReviewResultFromDB(state.runId);

  return {
    passed,
    issues,
    suggestions: [],
    costUsd,
  };
}
