import assert from 'node:assert';
import { describe, test } from 'node:test';
import { BUILD_PROMPT } from './prompts.js';

describe('Build Prompt', () => {
  test('includes Iron Law verification requirements', () => {
    assert.ok(BUILD_PROMPT.includes('Iron Law'), 'Should include Iron Law section');
    assert.ok(
      BUILD_PROMPT.includes('Verification Before Completion'),
      'Should mention verification before completion'
    );
  });

  test('includes exit signals', () => {
    assert.ok(BUILD_PROMPT.includes('ITERATION_DONE'), 'Should include ITERATION_DONE signal');
    assert.ok(BUILD_PROMPT.includes('TASK_COMPLETE'), 'Should include TASK_COMPLETE signal');
    assert.ok(BUILD_PROMPT.includes('TASK_STUCK'), 'Should include TASK_STUCK signal');
  });

  test('includes How to Work section with scratchpad', () => {
    assert.ok(BUILD_PROMPT.includes('How to Work'), 'Should include How to Work section');
    assert.ok(BUILD_PROMPT.includes('write_scratchpad'), 'Should reference write_scratchpad tool');
  });
});
