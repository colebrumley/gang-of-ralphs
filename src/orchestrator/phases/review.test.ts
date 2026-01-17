import assert from 'node:assert';
import { describe, test } from 'node:test';
import { getReviewPrompt } from './review.js';

describe('Review Phase', () => {
  // NOTE: Review result recording now happens via MCP tools (set_review_result)
  // The loadReviewResultFromDB function reads from the database after agent runs
  // Integration tests should verify MCP tool usage

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

  test('getReviewPrompt requests structured issues via MCP', () => {
    const prompt = getReviewPrompt('standard');

    assert.ok(prompt.includes('set_review_result'), 'Should instruct use of MCP tool');
    assert.ok(prompt.includes('file'), 'Should request file location');
    assert.ok(
      prompt.includes('suggestion') || prompt.includes('fix'),
      'Should request fix suggestion'
    );
  });
});
