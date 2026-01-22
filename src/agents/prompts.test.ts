import assert from 'node:assert';
import { describe, test } from 'node:test';
import { BUILD_PROMPT } from './prompts.js';

describe('Build Prompt', () => {
  test('includes Atomic Update Rule section', () => {
    assert.ok(
      BUILD_PROMPT.includes('Atomic Update Rule'),
      'Should include Atomic Update Rule section'
    );
    assert.ok(
      BUILD_PROMPT.includes('Each iteration = ONE atomic change'),
      'Should emphasize one atomic change per iteration'
    );
  });

  test('includes exit signals', () => {
    assert.ok(BUILD_PROMPT.includes('ITERATION_DONE'), 'Should include ITERATION_DONE signal');
    assert.ok(BUILD_PROMPT.includes('TASK_COMPLETE'), 'Should include TASK_COMPLETE signal');
    assert.ok(BUILD_PROMPT.includes('TASK_STUCK'), 'Should include TASK_STUCK signal');
  });

  test('includes Iteration Structure section with write_context', () => {
    assert.ok(
      BUILD_PROMPT.includes('Iteration Structure'),
      'Should include Iteration Structure section'
    );
    assert.ok(BUILD_PROMPT.includes('write_context'), 'Should reference write_context tool');
    assert.ok(BUILD_PROMPT.includes('read_context'), 'Should reference read_context tool');
  });

  test('emphasizes ITERATION_DONE as default', () => {
    assert.ok(
      BUILD_PROMPT.includes('Default to ITERATION_DONE'),
      'Should emphasize ITERATION_DONE as default'
    );
    assert.ok(
      BUILD_PROMPT.includes('TASK_COMPLETE is rare'),
      'Should indicate TASK_COMPLETE is rare'
    );
  });
});
