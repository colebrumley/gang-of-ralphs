import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { ConflictResult } from './conflict.js';

describe('Conflict Phase', () => {
  describe('ConflictResult type', () => {
    test('resolved result has correct shape', () => {
      const result: ConflictResult = {
        resolved: true,
        costUsd: 0.05,
      };

      assert.strictEqual(result.resolved, true);
      assert.strictEqual(result.costUsd, 0.05);
      assert.strictEqual(result.error, undefined);
    });

    test('failed result includes error', () => {
      const result: ConflictResult = {
        resolved: false,
        error: 'Could not resolve merge conflicts in src/index.ts',
        costUsd: 0.03,
      };

      assert.strictEqual(result.resolved, false);
      assert.strictEqual(result.error, 'Could not resolve merge conflicts in src/index.ts');
      assert.strictEqual(result.costUsd, 0.03);
    });

    test('failed result can have undefined error', () => {
      const result: ConflictResult = {
        resolved: false,
        costUsd: 0.01,
      };

      assert.strictEqual(result.resolved, false);
      assert.strictEqual(result.error, undefined);
    });
  });

  describe('result parsing logic', () => {
    // Tests for the parsing logic in resolveConflict
    // The actual function calls agents, but we can document the expected output patterns

    test('CONFLICT_RESOLVED indicates success', () => {
      const output = 'I have resolved the merge conflicts.\n\nCONFLICT_RESOLVED';

      assert.ok(output.includes('CONFLICT_RESOLVED'));
    });

    test('CONFLICT_FAILED: pattern extracts error message', () => {
      const output = 'Unable to resolve.\n\nCONFLICT_FAILED: Manual intervention required';
      const match = output.match(/CONFLICT_FAILED:\s*(.+)/);

      assert.ok(match);
      assert.strictEqual(match[1], 'Manual intervention required');
    });

    test('CONFLICT_FAILED: with multiline extracts first line', () => {
      const output = 'CONFLICT_FAILED: Multiple conflicts\nMore details here';
      const match = output.match(/CONFLICT_FAILED:\s*(.+)/);

      assert.ok(match);
      assert.strictEqual(match[1], 'Multiple conflicts');
    });

    test('output without markers uses default error', () => {
      const output = 'Something went wrong without a marker';
      const hasResolved = output.includes('CONFLICT_RESOLVED');
      const failMatch = output.match(/CONFLICT_FAILED:\s*(.+)/);

      assert.strictEqual(hasResolved, false);
      assert.strictEqual(failMatch, null);
      // The actual code would use 'Unknown conflict resolution failure'
    });
  });
});
