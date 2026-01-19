import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { LoopState, Task } from '../../types/index.js';
import { getLoopReviewPrompt, getReviewPrompt } from './review.js';

describe('Review Phase', () => {
  // NOTE: Review result recording now happens via MCP tools (set_review_result)
  // The loadReviewResultFromDB function reads from the database after agent runs
  // Integration tests should verify MCP tool usage

  test('getReviewPrompt varies by depth for build reviews', () => {
    const shallow = getReviewPrompt('shallow', 'build');
    const deep = getReviewPrompt('deep', 'build');

    assert.ok(shallow.includes('basic'));
    assert.ok(deep.includes('comprehensive'));
  });

  test('getReviewPrompt includes quality checks at standard depth for build reviews', () => {
    const prompt = getReviewPrompt('standard', 'build');

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
    const prompt = getReviewPrompt('standard', 'build');

    assert.ok(prompt.includes('set_review_result'), 'Should instruct use of MCP tool');
    assert.ok(prompt.includes('file'), 'Should request file location');
    assert.ok(
      prompt.includes('suggestion') || prompt.includes('fix'),
      'Should request fix suggestion'
    );
  });

  test('getReviewPrompt generates plan-specific prompt for plan reviews', () => {
    const prompt = getReviewPrompt('standard', 'plan');

    assert.ok(prompt.includes('PLAN REVIEW'), 'Should identify as plan review');
    assert.ok(prompt.includes('execution plan'), 'Should reference execution plan');
    assert.ok(
      prompt.includes('dependency') || prompt.includes('dependencies'),
      'Should check dependencies'
    );
    assert.ok(prompt.includes('parallel'), 'Should check parallelization');
    // Plan review should NOT include code-specific checks
    assert.ok(!prompt.includes('tests pass'), 'Should not ask about tests');
    assert.ok(!prompt.includes('dead code'), 'Should not check for dead code');
  });

  test('getReviewPrompt generates enumerate-specific prompt for enumerate reviews', () => {
    const prompt = getReviewPrompt('standard', 'enumerate');

    assert.ok(prompt.includes('ENUMERATE REVIEW'), 'Should identify as enumerate review');
    assert.ok(prompt.includes('enumerated tasks'), 'Should reference enumerated tasks');
    assert.ok(
      prompt.includes('Missing tasks') || prompt.includes('requirements'),
      'Should check for missing tasks'
    );
    // Enumerate review should NOT include code-specific checks
    assert.ok(!prompt.includes('tests pass'), 'Should not ask about tests');
    assert.ok(!prompt.includes('dead code'), 'Should not check for dead code');
  });
});

describe('Checkpoint Review Prompts', () => {
  const mockLoop: LoopState = {
    loopId: 'test-loop-123',
    taskIds: ['t1'],
    iteration: 5,
    maxIterations: 20,
    reviewInterval: 5,
    lastReviewAt: 0,
    status: 'running',
    stuckIndicators: {
      sameErrorCount: 0,
      noProgressCount: 0,
      lastError: null,
      lastFileChangeIteration: 0,
      lastActivityAt: Date.now(),
    },
    output: [],
    worktreePath: '/path/to/worktree',
    phase: 'build',
    reviewStatus: 'pending',
    lastReviewId: null,
    revisionAttempts: 0,
    lastCheckpointReviewAt: 0,
  };

  const mockTask: Task = {
    id: 't1',
    title: 'Test Task',
    description: 'A test task description',
    status: 'pending',
    dependencies: [],
    estimatedIterations: 10,
    assignedLoopId: 'test-loop-123',
  };

  test('getLoopReviewPrompt generates task completion prompt by default', () => {
    const prompt = getLoopReviewPrompt(mockLoop, mockTask, '', 'standard');

    assert.ok(prompt.includes('LOOP REVIEW'), 'Should identify as loop review');
    assert.ok(!prompt.includes('CHECKPOINT REVIEW'), 'Should not be checkpoint review');
    assert.ok(!prompt.includes('Checkpoint Review Note'), 'Should not include checkpoint note');
  });

  test('getLoopReviewPrompt generates checkpoint-specific prompt when isCheckpoint=true', () => {
    const prompt = getLoopReviewPrompt(mockLoop, mockTask, '', 'standard', true);

    assert.ok(prompt.includes('CHECKPOINT REVIEW'), 'Should identify as checkpoint review');
    assert.ok(prompt.includes('interim checkpoint review'), 'Should mention interim review');
    assert.ok(prompt.includes('NOT yet complete'), 'Should clarify task is not complete');
    assert.ok(prompt.includes('Checkpoint Review Note'), 'Should include checkpoint note');
    assert.ok(
      prompt.includes("Don't fail the review just because the task isn't finished"),
      'Should advise about incomplete task'
    );
  });

  test('checkpoint prompt includes iteration progress', () => {
    const prompt = getLoopReviewPrompt(mockLoop, mockTask, '', 'standard', true);

    assert.ok(prompt.includes('Iteration: 5/20'), 'Should show iteration progress');
    assert.ok(prompt.includes('at iteration 5'), 'Should reference current iteration');
  });

  test('checkpoint prompt focuses on catching issues early', () => {
    const prompt = getLoopReviewPrompt(mockLoop, mockTask, '', 'standard', true);

    assert.ok(prompt.includes('Are we on the right track'), 'Should focus on direction checking');
    assert.ok(
      prompt.includes('any issues or bugs introduced so far'),
      'Should focus on early issue detection'
    );
    assert.ok(prompt.includes('Is the approach sound'), 'Should focus on approach validation');
  });
});
