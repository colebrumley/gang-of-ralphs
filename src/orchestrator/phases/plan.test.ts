import assert from 'node:assert';
import { describe, test } from 'node:test';
import { PlanIncompleteError, buildTaskGraph } from './plan.js';

describe('Plan Phase', () => {
  // NOTE: Plan group creation now happens via MCP tools (add_plan_group)
  // The loadPlanGroupsFromDB function reads from the database after agent runs
  // Integration tests should verify MCP tool usage

  test('buildTaskGraph creates valid graph from tasks and groups', () => {
    const tasks = [
      {
        id: 'task-1',
        title: 'A',
        description: '',
        status: 'pending' as const,
        dependencies: [],
        estimatedIterations: 5,
        assignedLoopId: null,
      },
      {
        id: 'task-2',
        title: 'B',
        description: '',
        status: 'pending' as const,
        dependencies: [],
        estimatedIterations: 5,
        assignedLoopId: null,
      },
    ];
    const parallelGroups = [['task-1', 'task-2']];

    const graph = buildTaskGraph(tasks, parallelGroups);

    assert.strictEqual(graph.tasks.length, 2);
    assert.deepStrictEqual(graph.parallelGroups, parallelGroups);
  });
});

describe('PlanIncompleteError', () => {
  test('includes group count in error message', () => {
    const error = new PlanIncompleteError(2, 'some output');
    assert.ok(error.message.includes('2 partial plan groups'));
    assert.strictEqual(error.groupCount, 2);
  });

  test('includes truncated output in error message', () => {
    const longOutput = 'y'.repeat(500);
    const error = new PlanIncompleteError(0, longOutput);
    // Should include last 200 characters
    assert.ok(error.message.includes('y'.repeat(200)));
    assert.strictEqual(error.output, longOutput);
  });

  test('has correct error name', () => {
    const error = new PlanIncompleteError(0, '');
    assert.strictEqual(error.name, 'PlanIncompleteError');
  });

  test('indicates PLAN_COMPLETE was missing', () => {
    const error = new PlanIncompleteError(0, '');
    assert.ok(error.message.includes('PLAN_COMPLETE'));
  });
});
