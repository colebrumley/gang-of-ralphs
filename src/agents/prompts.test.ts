import assert from 'node:assert';
import { describe, test } from 'node:test';
import { BUILD_PROMPT } from './prompts.js';

describe('Build Prompt', () => {
  test('includes anti-over-engineering guidance', () => {
    assert.ok(BUILD_PROMPT.includes('abstraction'), 'Should mention abstractions');
    assert.ok(
      BUILD_PROMPT.includes('once') || BUILD_PROMPT.includes('single'),
      'Should warn against single-use abstractions'
    );
  });

  test('includes error handling requirements', () => {
    assert.ok(
      BUILD_PROMPT.includes('error') || BUILD_PROMPT.includes('Error'),
      'Should mention error handling'
    );
    assert.ok(
      BUILD_PROMPT.includes('boundary') || BUILD_PROMPT.includes('boundaries'),
      'Should mention boundaries'
    );
  });

  test('includes grounding instruction', () => {
    assert.ok(
      BUILD_PROMPT.includes('existing') || BUILD_PROMPT.includes('pattern'),
      'Should reference existing patterns'
    );
    assert.ok(
      BUILD_PROMPT.includes('simplest') || BUILD_PROMPT.includes('minimal'),
      'Should emphasize simplicity'
    );
  });
});
