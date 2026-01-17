import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { OrchestratorContext, ReviewIssue } from './state.js';

describe('State Types', () => {
  test('ReviewIssue has required fields', () => {
    const issue: ReviewIssue = {
      taskId: 'task-1',
      file: 'src/index.ts',
      line: 42,
      type: 'over-engineering',
      description: 'Unnecessary abstraction',
      suggestion: 'Inline the function',
    };

    assert.strictEqual(issue.taskId, 'task-1');
    assert.strictEqual(issue.type, 'over-engineering');
  });

  test('OrchestratorContext includes reviewIssues', () => {
    const context: OrchestratorContext = {
      discoveries: [],
      errors: [],
      decisions: [],
      reviewIssues: [],
    };

    assert.ok(Array.isArray(context.reviewIssues));
  });
});
