import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, ReviewType, ReviewIssue, ReviewIssueType } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import type { EffortConfig } from '../../config/effort.js';

export interface ReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
  suggestions: string[];
}

function normalizeIssue(issue: unknown): ReviewIssue {
  if (typeof issue === 'string') {
    // Legacy format: convert string to structured issue
    return {
      taskId: '',
      file: 'unknown',
      type: 'pattern-violation' as ReviewIssueType,
      description: issue,
      suggestion: 'Review and fix this issue',
    };
  }

  // Structured format
  const obj = issue as Record<string, unknown>;
  return {
    taskId: '',
    file: (obj.file as string) || 'unknown',
    line: obj.line as number | undefined,
    type: (obj.type as ReviewIssueType) || 'pattern-violation',
    description: (obj.description as string) || 'Unknown issue',
    suggestion: (obj.suggestion as string) || 'Review and fix',
  };
}

export function parseReviewOutput(output: string): ReviewResult {
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    output.match(/(\{[\s\S]*"passed"[\s\S]*\})/);

  if (!jsonMatch) {
    return {
      passed: false,
      issues: [{
        taskId: '',
        file: 'unknown',
        type: 'pattern-violation',
        description: 'Failed to parse review output',
        suggestion: 'Check agent output format'
      }],
      suggestions: []
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    const rawIssues = parsed.issues ?? [];

    return {
      passed: parsed.passed ?? false,
      issues: rawIssues.map((issue: unknown) => normalizeIssue(issue)),
      suggestions: parsed.suggestions ?? [],
    };
  } catch {
    return {
      passed: false,
      issues: [{
        taskId: '',
        file: 'unknown',
        type: 'pattern-violation',
        description: 'Failed to parse review JSON',
        suggestion: 'Check JSON syntax'
      }],
      suggestions: []
    };
  }
}

export function getReviewPrompt(depth: EffortConfig['reviewDepth']): string {
  const base = `You are a code reviewer. Evaluate the work done.

Output a JSON object:
{
  "passed": true/false,
  "issues": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "type": "over-engineering|missing-error-handling|pattern-violation|dead-code",
      "description": "What's wrong",
      "suggestion": "How to fix it"
    }
  ],
  "suggestions": ["optional improvements"]
}`;

  const qualityChecks = `
**Check for these quality issues:**
- Unnecessary abstractions: classes/functions used only once, premature generalization
- Missing error handling: unhandled promise rejections, unchecked file/network operations, no input validation at boundaries
- Pattern violations: code that doesn't match existing codebase conventions
- Dead code: unused imports, unreachable branches, commented-out code

For each issue, specify the file, line number, what's wrong, and how to fix it.`;

  switch (depth) {
    case 'shallow':
      return `${base}

Perform a basic review:
- Do tests pass?
- Are there obvious bugs?`;

    case 'standard':
      return `${base}
${qualityChecks}

Perform a standard review:
- Do tests pass?
- Does the code match the spec?
- Are there bugs or edge cases?`;

    case 'deep':
      return `${base}
${qualityChecks}

Perform a comprehensive review:
- Do tests pass?
- Does implementation match spec?
- Are edge cases handled?
- Is error handling adequate?
- Is the approach optimal?`;

    case 'comprehensive':
      return `${base}
${qualityChecks}

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
    case 'build': {
      const taskDetails = state.completedTasks.map(id => {
        const task = state.tasks.find(t => t.id === id);
        return task ? `- ${id}: ${task.title}\n  ${task.description}` : `- ${id}`;
      }).join('\n');
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

  for await (const message of query({
    prompt,
    options: {
      allowedTools: config.allowedTools,
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
