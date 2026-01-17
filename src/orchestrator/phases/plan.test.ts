import assert from 'node:assert';
import { describe, test } from 'node:test';
import { buildTaskGraph, parsePlanOutput } from './plan.js';

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

    assert.deepStrictEqual(result.parallelGroups, [['task-1', 'task-2'], ['task-3']]);
  });

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
