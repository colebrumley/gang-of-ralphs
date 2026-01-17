import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { ReviewIssue, Task, TaskGraph } from '../../types/index.js';
import { buildPromptWithFeedback, canStartGroup, getNextParallelGroup } from './build.js';

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

    assert.ok(prompt.includes('Previous Review Feedback'), 'Should include feedback header');
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

    assert.ok(!prompt.includes('Previous Review Feedback'), 'Should not include feedback header');
    assert.ok(prompt.includes('Task 1'), 'Should include task title');
  });
});
