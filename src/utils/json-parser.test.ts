import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractJSON, JSONExtractionError } from './json-parser.js';

describe('JSON Parser', () => {
  test('extracts JSON from markdown code block', () => {
    const output = `Some thinking...
\`\`\`json
{
  "tasks": [
    { "id": "task-1", "title": "Test" }
  ]
}
\`\`\`
Done!`;

    const result = extractJSON<{ tasks: { id: string; title: string }[] }>(
      output,
      ['tasks']
    );

    assert.strictEqual(result.tasks.length, 1);
    assert.strictEqual(result.tasks[0].id, 'task-1');
  });

  test('extracts JSON from generic code block', () => {
    const output = `\`\`\`
{"name": "test"}
\`\`\``;

    const result = extractJSON<{ name: string }>(output, ['name']);
    assert.strictEqual(result.name, 'test');
  });

  test('extracts bare JSON object', () => {
    const output = `The result is: {"value": 42}`;

    const result = extractJSON<{ value: number }>(output, ['value']);
    assert.strictEqual(result.value, 42);
  });

  test('throws JSONExtractionError when no JSON found', () => {
    const output = 'No JSON here at all';

    assert.throws(
      () => extractJSON(output, ['tasks']),
      JSONExtractionError
    );
  });

  test('throws when required keys missing', () => {
    const output = '{"other": "value"}';

    assert.throws(
      () => extractJSON(output, ['tasks']),
      JSONExtractionError
    );
  });

  test('validates multiple required keys', () => {
    const output = '{"tasks": [], "parallelGroups": []}';

    const result = extractJSON<{ tasks: unknown[]; parallelGroups: unknown[] }>(
      output, ['tasks', 'parallelGroups']
    );
    assert.ok('tasks' in result);
    assert.ok('parallelGroups' in result);
  });
});
