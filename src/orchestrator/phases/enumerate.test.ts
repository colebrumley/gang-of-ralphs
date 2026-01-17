import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseEnumerateOutput } from './enumerate.js';

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

    assert.throws(() => parseEnumerateOutput(output), /Failed to parse/);
  });
});
