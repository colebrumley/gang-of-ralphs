import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseEnumerateOutput, validateTaskGranularity } from './enumerate.js';

describe('Enumerate Phase', () => {
  test('parseEnumerateOutput extracts tasks from JSON', () => {
    const output = `Some thinking...
\`\`\`json
{
  "tasks": [
    {
      "id": "task-1",
      "title": "Create greet function",
      "description": "Implement greet(name) function",
      "dependencies": [],
      "estimatedIterations": 5
    }
  ]
}
\`\`\`
Done!`;

    const tasks = parseEnumerateOutput(output);

    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, 'task-1');
    assert.strictEqual(tasks[0].title, 'Create greet function');
  });

  test('parseEnumerateOutput handles invalid JSON gracefully', () => {
    const output = 'No JSON here';

    assert.throws(() => parseEnumerateOutput(output), /No valid JSON/);
  });

  // Risk #5 mitigation: Task granularity validation
  test('validateTaskGranularity warns on too-large tasks', () => {
    const tasks = [
      { id: 't1', title: 'Huge task', description: 'Everything that needs doing',
        status: 'pending' as const, dependencies: [], estimatedIterations: 50, assignedLoopId: null }
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some(w => w.includes('too large')));
  });

  test('validateTaskGranularity warns on too-small tasks', () => {
    const tasks = [
      { id: 't1', title: 'Tiny', description: 'A very small task description',
        status: 'pending' as const, dependencies: [], estimatedIterations: 1, assignedLoopId: null }
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some(w => w.includes('too small')));
  });

  test('validateTaskGranularity warns on short descriptions', () => {
    const tasks = [
      { id: 't1', title: 'Task', description: 'x',
        status: 'pending' as const, dependencies: [], estimatedIterations: 10, assignedLoopId: null }
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some(w => w.includes('short description')));
  });

  test('validateTaskGranularity passes for well-sized tasks', () => {
    const tasks = [
      { id: 't1', title: 'Good task', description: 'A reasonably detailed task description',
        status: 'pending' as const, dependencies: [], estimatedIterations: 10, assignedLoopId: null }
    ];
    const result = validateTaskGranularity(tasks);
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.valid, true);
  });
});
