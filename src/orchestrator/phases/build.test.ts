import assert from 'node:assert';
import { describe, test } from 'node:test';
import { BUILD_PROMPT } from '../../agents/prompts.js';
import type { ReviewIssue, Task, TaskGraph } from '../../types/index.js';
import {
  buildIterationPrompt,
  buildPromptWithFeedback,
  canStartGroup,
  getNextParallelGroup,
} from './build.js';

// Helper to simulate the issue replacement logic used in executeBuildIteration
function replaceIssuesForTask(
  existingIssues: ReviewIssue[],
  taskId: string,
  newIssues: ReviewIssue[]
): ReviewIssue[] {
  const filtered = existingIssues.filter((i) => i.taskId !== taskId);
  return [...filtered, ...newIssues];
}

// Helper to simulate clearing issues for a completed task
function clearIssuesForTask(existingIssues: ReviewIssue[], taskId: string): ReviewIssue[] {
  return existingIssues.filter((i) => i.taskId !== taskId);
}

describe('Build Phase', () => {
  const tasks: Task[] = [
    {
      id: 't1',
      title: 'Task 1',
      description: '',
      status: 'pending',
      dependencies: [],
      estimatedIterations: 5,
      assignedLoopId: null,
    },
    {
      id: 't2',
      title: 'Task 2',
      description: '',
      status: 'pending',
      dependencies: [],
      estimatedIterations: 5,
      assignedLoopId: null,
    },
    {
      id: 't3',
      title: 'Task 3',
      description: '',
      status: 'pending',
      dependencies: ['t1', 't2'],
      estimatedIterations: 5,
      assignedLoopId: null,
    },
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

  test('buildPromptWithFeedback includes review issues for task', () => {
    const task: Task = {
      id: 't1',
      title: 'Task 1',
      description: 'Do something',
      status: 'pending',
      dependencies: [],
      estimatedIterations: 5,
      assignedLoopId: null,
    };

    const issues: ReviewIssue[] = [
      {
        taskId: 't1',
        file: 'src/index.ts',
        line: 42,
        type: 'over-engineering',
        description: 'Unnecessary wrapper',
        suggestion: 'Inline the code',
      },
      {
        taskId: 't2', // Different task
        file: 'src/other.ts',
        line: 10,
        type: 'missing-error-handling',
        description: 'Unhandled error',
        suggestion: 'Add try-catch',
      },
    ];

    const prompt = buildPromptWithFeedback(task, issues, 1, 10);

    assert.ok(
      prompt.includes('Review Feedback from Previous Attempt'),
      'Should include feedback header'
    );
    assert.ok(prompt.includes('src/index.ts:42'), 'Should include file and line');
    assert.ok(prompt.includes('Unnecessary wrapper'), 'Should include description');
    assert.ok(prompt.includes('Inline the code'), 'Should include suggestion');
    assert.ok(!prompt.includes('src/other.ts'), 'Should not include other task issues');
  });

  test('buildPromptWithFeedback works without issues', () => {
    const task: Task = {
      id: 't1',
      title: 'Task 1',
      description: 'Do something',
      status: 'pending',
      dependencies: [],
      estimatedIterations: 5,
      assignedLoopId: null,
    };

    const prompt = buildPromptWithFeedback(task, [], 1, 10);

    assert.ok(
      !prompt.includes('Review Feedback from Previous Attempt'),
      'Should not include feedback header'
    );
    assert.ok(prompt.includes('Task 1'), 'Should include task title');
  });

  test('buildPromptWithFeedback starts with static BUILD_PROMPT for cache efficiency', () => {
    const task: Task = {
      id: 't1',
      title: 'Task 1',
      description: 'Do something',
      status: 'pending',
      dependencies: [],
      estimatedIterations: 5,
      assignedLoopId: null,
    };

    const prompt = buildPromptWithFeedback(task, [], 1, 10);

    assert.ok(
      prompt.startsWith(BUILD_PROMPT),
      'Prompt must start with static BUILD_PROMPT for API-level prompt caching'
    );
  });

  test('buildPromptWithFeedback puts review feedback after static content', () => {
    const task: Task = {
      id: 't1',
      title: 'Task 1',
      description: 'Do something',
      status: 'pending',
      dependencies: [],
      estimatedIterations: 5,
      assignedLoopId: null,
    };

    const issues: ReviewIssue[] = [
      {
        taskId: 't1',
        file: 'src/index.ts',
        line: 42,
        type: 'over-engineering',
        description: 'Unnecessary wrapper',
        suggestion: 'Inline the code',
      },
    ];

    const prompt = buildPromptWithFeedback(task, issues, 1, 10);

    // Static content should come first
    assert.ok(
      prompt.startsWith(BUILD_PROMPT),
      'Prompt must start with static BUILD_PROMPT even with review feedback'
    );

    // Review feedback should come after static content
    const buildPromptEnd = prompt.indexOf(BUILD_PROMPT) + BUILD_PROMPT.length;
    const feedbackIndex = prompt.indexOf('Review Feedback from Previous Attempt');
    assert.ok(
      feedbackIndex > buildPromptEnd,
      'Review feedback must come after static BUILD_PROMPT for cache efficiency'
    );
  });

  test('replaceIssuesForTask replaces issues instead of accumulating', () => {
    // Simulate: task t1 had old issues from a previous failed review
    const oldIssues: ReviewIssue[] = [
      {
        taskId: 't1',
        file: 'src/old.ts',
        line: 1,
        type: 'over-engineering',
        description: 'Old issue that was fixed',
        suggestion: 'Fix it',
      },
      {
        taskId: 't2', // Different task - should be preserved
        file: 'src/other.ts',
        line: 2,
        type: 'pattern-violation',
        description: 'Issue for other task',
        suggestion: 'Keep this',
      },
    ];

    // New review finds different issues for t1
    const newIssues: ReviewIssue[] = [
      {
        taskId: 't1',
        file: 'src/new.ts',
        line: 10,
        type: 'missing-error-handling',
        description: 'New issue found',
        suggestion: 'Fix new issue',
      },
    ];

    const result = replaceIssuesForTask(oldIssues, 't1', newIssues);

    // Should only have the new t1 issue and the preserved t2 issue
    assert.strictEqual(result.length, 2);
    assert.ok(
      result.some((i) => i.taskId === 't2' && i.description === 'Issue for other task'),
      'Should preserve issues for other tasks'
    );
    assert.ok(
      result.some((i) => i.taskId === 't1' && i.description === 'New issue found'),
      'Should have new issue for t1'
    );
    assert.ok(
      !result.some((i) => i.description === 'Old issue that was fixed'),
      'Should NOT have old stale issue for t1'
    );
  });

  test('clearIssuesForTask removes all issues for completed task', () => {
    const issues: ReviewIssue[] = [
      {
        taskId: 't1',
        file: 'src/a.ts',
        line: 1,
        type: 'over-engineering',
        description: 'Issue 1 for t1',
        suggestion: 'Fix 1',
      },
      {
        taskId: 't1',
        file: 'src/b.ts',
        line: 2,
        type: 'pattern-violation',
        description: 'Issue 2 for t1',
        suggestion: 'Fix 2',
      },
      {
        taskId: 't2',
        file: 'src/c.ts',
        line: 3,
        type: 'dead-code',
        description: 'Issue for t2',
        suggestion: 'Fix 3',
      },
    ];

    // Task t1 completes successfully - clear its issues
    const result = clearIssuesForTask(issues, 't1');

    // Should only have t2's issue remaining
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].taskId, 't2');
    assert.strictEqual(result[0].description, 'Issue for t2');
  });

  test('issue accumulation bug scenario - old issues should not leak into new iterations', () => {
    // Scenario: Task goes through multiple review cycles
    // Iteration 1: Review fails with issues A, B
    // Iteration 2: Agent fixes A, B; review fails with issue C (A, B fixed but new issue found)
    // Expected: Only issue C should be in feedback, not stale A, B

    const task: Task = {
      id: 't1',
      title: 'Task 1',
      description: 'Implement feature',
      status: 'pending',
      dependencies: [],
      estimatedIterations: 5,
      assignedLoopId: null,
    };

    // After iteration 1's failed review
    let reviewIssues: ReviewIssue[] = [
      {
        taskId: 't1',
        file: 'src/index.ts',
        line: 10,
        type: 'over-engineering',
        description: 'Issue A',
        suggestion: 'Fix A',
      },
      {
        taskId: 't1',
        file: 'src/index.ts',
        line: 20,
        type: 'dead-code',
        description: 'Issue B',
        suggestion: 'Fix B',
      },
    ];

    // Agent works on fixes... iteration 2's review finds only issue C
    const iteration2Issues: ReviewIssue[] = [
      {
        taskId: 't1',
        file: 'src/index.ts',
        line: 30,
        type: 'pattern-violation',
        description: 'Issue C',
        suggestion: 'Fix C',
      },
    ];

    // With the fix: replace issues for t1 instead of accumulating
    reviewIssues = replaceIssuesForTask(reviewIssues, 't1', iteration2Issues);

    // Build prompt should only mention Issue C
    const prompt = buildPromptWithFeedback(task, reviewIssues, 3, 10);

    assert.ok(prompt.includes('Issue C'), 'Should include current issue C');
    assert.ok(!prompt.includes('Issue A'), 'Should NOT include stale issue A');
    assert.ok(!prompt.includes('Issue B'), 'Should NOT include stale issue B');
  });
});

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
    const issues: ReviewIssue[] = [
      {
        taskId: 'task-1',
        file: 'src/foo.ts',
        line: 42,
        type: 'missing-error-handling',
        description: 'No error handling',
        suggestion: 'Add try/catch',
      },
    ];
    const prompt = buildIterationPrompt(mockTask, null, 1, 10, issues);
    assert.ok(prompt.includes('src/foo.ts:42'));
    assert.ok(prompt.includes('No error handling'));
  });

  test('includes iteration count', () => {
    const prompt = buildIterationPrompt(mockTask, null, 5, 10, []);
    assert.ok(prompt.includes('5/10'));
  });
});
