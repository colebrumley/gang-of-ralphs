import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, initializeState } from './index.js';

describe('State Management', () => {
  test('initializeState creates valid initial state', async () => {
    const state = initializeState({
      specPath: '/path/to/spec.md',
      effort: 'medium',
      stateDir: '.c2',
      maxLoops: 4,
      maxIterations: 20,
    });

    assert.strictEqual(state.phase, 'enumerate');
    assert.strictEqual(state.effort, 'medium');
    assert.ok(state.runId);
  });

  test('saveState and loadState round-trip correctly', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'c2-test-'));
    const stateDir = join(tempDir, '.c2');

    try {
      const state = initializeState({
        specPath: '/path/to/spec.md',
        effort: 'high',
        stateDir,
        maxLoops: 4,
        maxIterations: 20,
      });

      await saveState(state);
      const loaded = await loadState(stateDir);

      assert.deepStrictEqual(loaded, state);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  test('loadState returns null for non-existent state', async () => {
    const result = await loadState('/nonexistent/.c2');
    assert.strictEqual(result, null);
  });
});
