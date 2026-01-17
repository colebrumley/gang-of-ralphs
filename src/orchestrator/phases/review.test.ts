import assert from 'node:assert';
import { describe, test } from 'node:test';
import { getReviewPrompt, parseReviewOutput } from './review.js';

describe('Review Phase', () => {
  test('parseReviewOutput extracts passed status', () => {
    const output = `\`\`\`json
{
  "passed": true,
  "issues": [],
  "suggestions": ["Consider adding more tests"]
}
\`\`\``;

    const result = parseReviewOutput(output);

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.issues.length, 0);
  });

  test('parseReviewOutput extracts issues count', () => {
    const output = `\`\`\`json
{
  "passed": false,
  "issues": ["Missing error handling", "No tests"],
  "suggestions": []
}
\`\`\``;

    const result = parseReviewOutput(output);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.issues.length, 2);
    // Issues are now normalized to ReviewIssue objects
    assert.strictEqual(result.issues[0].description, 'Missing error handling');
  });

  test('getReviewPrompt varies by depth', () => {
    const shallow = getReviewPrompt('shallow');
    const deep = getReviewPrompt('deep');

    assert.ok(shallow.includes('basic'));
    assert.ok(deep.includes('comprehensive'));
  });

  test('getReviewPrompt includes quality checks at standard depth', () => {
    const prompt = getReviewPrompt('standard');

    assert.ok(
      prompt.includes('abstraction') || prompt.includes('over-engineer'),
      'Should check for over-engineering'
    );
    assert.ok(
      prompt.includes('error handling') || prompt.includes('unhandled'),
      'Should check error handling'
    );
  });

  test('getReviewPrompt requests structured issues', () => {
    const prompt = getReviewPrompt('standard');

    assert.ok(prompt.includes('file'), 'Should request file location');
    assert.ok(prompt.includes('line') || prompt.includes('location'), 'Should request line number');
    assert.ok(
      prompt.includes('suggestion') || prompt.includes('fix'),
      'Should request fix suggestion'
    );
  });

  test('parseReviewOutput extracts structured issues', () => {
    const output = `\`\`\`json
{
  "passed": false,
  "issues": [
    {
      "file": "src/utils.ts",
      "line": 15,
      "type": "over-engineering",
      "description": "Unnecessary wrapper class",
      "suggestion": "Use a plain function instead"
    }
  ],
  "suggestions": []
}
\`\`\``;

    const result = parseReviewOutput(output);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.issues.length, 1);
    assert.strictEqual(result.issues[0].file, 'src/utils.ts');
    assert.strictEqual(result.issues[0].line, 15);
    assert.strictEqual(result.issues[0].type, 'over-engineering');
  });

  test('parseReviewOutput handles legacy string issues', () => {
    const output = `\`\`\`json
{
  "passed": false,
  "issues": ["Missing error handling", "No tests"],
  "suggestions": []
}
\`\`\``;

    const result = parseReviewOutput(output);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.issues.length, 2);
    // Legacy issues should be converted to structured format
    assert.strictEqual(result.issues[0].description, 'Missing error handling');
    assert.strictEqual(result.issues[0].type, 'pattern-violation');
  });
});
