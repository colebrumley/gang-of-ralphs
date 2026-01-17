import assert from 'node:assert';
import { describe, test } from 'node:test';
import { parseReviseOutput } from './revise.js';

describe('Revise Phase', () => {
  describe('parseReviseOutput', () => {
    test('parses valid JSON in code block', () => {
      const output = `\`\`\`json
{
  "analysis": "The code has several issues with error handling",
  "fixes": [
    {
      "issue": "Missing try-catch",
      "file": "src/api.ts",
      "action": "Add error handling",
      "priority": "high"
    }
  ],
  "tasksToRetry": ["task-1", "task-2"],
  "additionalContext": "Focus on the API layer"
}
\`\`\``;

      const result = parseReviseOutput(output);

      assert.ok(result);
      assert.strictEqual(result.analysis, 'The code has several issues with error handling');
      assert.strictEqual(result.fixes.length, 1);
      assert.strictEqual(result.fixes[0].issue, 'Missing try-catch');
      assert.strictEqual(result.fixes[0].file, 'src/api.ts');
      assert.strictEqual(result.fixes[0].priority, 'high');
      assert.deepStrictEqual(result.tasksToRetry, ['task-1', 'task-2']);
      assert.strictEqual(result.additionalContext, 'Focus on the API layer');
    });

    test('parses JSON without code block markers', () => {
      const output = `Here is my analysis:
{
  "analysis": "Found problems",
  "fixes": [],
  "tasksToRetry": [],
  "additionalContext": ""
}`;

      const result = parseReviseOutput(output);

      assert.ok(result);
      assert.strictEqual(result.analysis, 'Found problems');
    });

    test('returns null for invalid JSON', () => {
      const output = 'This is just plain text without any JSON';

      const result = parseReviseOutput(output);

      assert.strictEqual(result, null);
    });

    test('returns null for malformed JSON', () => {
      const output = `\`\`\`json
{ "analysis": "incomplete...
\`\`\``;

      const result = parseReviseOutput(output);

      assert.strictEqual(result, null);
    });

    test('handles empty arrays and strings', () => {
      const output = `\`\`\`json
{
  "analysis": "",
  "fixes": [],
  "tasksToRetry": [],
  "additionalContext": ""
}
\`\`\``;

      const result = parseReviseOutput(output);

      assert.ok(result);
      assert.strictEqual(result.analysis, '');
      assert.deepStrictEqual(result.fixes, []);
      assert.deepStrictEqual(result.tasksToRetry, []);
      assert.strictEqual(result.additionalContext, '');
    });

    test('handles missing optional fields', () => {
      const output = `\`\`\`json
{
  "analysis": "Some analysis"
}
\`\`\``;

      const result = parseReviseOutput(output);

      assert.ok(result);
      assert.strictEqual(result.analysis, 'Some analysis');
      assert.deepStrictEqual(result.fixes, []);
      assert.deepStrictEqual(result.tasksToRetry, []);
      assert.strictEqual(result.additionalContext, '');
    });

    test('parses multiple fixes with different priorities', () => {
      const output = `\`\`\`json
{
  "analysis": "Multiple issues found",
  "fixes": [
    {"issue": "Critical bug", "file": "src/main.ts", "action": "Fix immediately", "priority": "high"},
    {"issue": "Style issue", "file": "src/utils.ts", "action": "Refactor later", "priority": "low"},
    {"issue": "Performance concern", "file": "src/db.ts", "action": "Optimize query", "priority": "medium"}
  ],
  "tasksToRetry": [],
  "additionalContext": ""
}
\`\`\``;

      const result = parseReviseOutput(output);

      assert.ok(result);
      assert.strictEqual(result.fixes.length, 3);
      assert.strictEqual(result.fixes[0].priority, 'high');
      assert.strictEqual(result.fixes[1].priority, 'low');
      assert.strictEqual(result.fixes[2].priority, 'medium');
    });

    test('extracts JSON from surrounding text', () => {
      const output = `I've analyzed the code and found the following issues:

\`\`\`json
{
  "analysis": "Found in surrounding text",
  "fixes": [],
  "tasksToRetry": ["task-3"],
  "additionalContext": "Important context"
}
\`\`\`

REVISE_COMPLETE

Let me know if you need more details.`;

      const result = parseReviseOutput(output);

      assert.ok(result);
      assert.strictEqual(result.analysis, 'Found in surrounding text');
      assert.deepStrictEqual(result.tasksToRetry, ['task-3']);
    });
  });
});
