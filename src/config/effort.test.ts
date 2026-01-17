import assert from 'node:assert';
import { describe, test } from 'node:test';
import { getEffortConfig } from './effort.js';

describe('Effort Configuration', () => {
  test('low effort has no intermediate reviews', () => {
    const config = getEffortConfig('low');
    assert.strictEqual(config.reviewAfterEnumerate, false);
    assert.strictEqual(config.reviewAfterPlan, false);
    assert.strictEqual(config.reviewInterval, 10);
  });

  test('medium effort reviews after plan', () => {
    const config = getEffortConfig('medium');
    assert.strictEqual(config.reviewAfterEnumerate, false);
    assert.strictEqual(config.reviewAfterPlan, true);
    assert.strictEqual(config.reviewInterval, 5);
  });

  test('high effort reviews after enumerate and plan', () => {
    const config = getEffortConfig('high');
    assert.strictEqual(config.reviewAfterEnumerate, true);
    assert.strictEqual(config.reviewAfterPlan, true);
    assert.strictEqual(config.reviewInterval, 3);
  });

  test('max effort reviews everything', () => {
    const config = getEffortConfig('max');
    assert.strictEqual(config.reviewAfterEnumerate, true);
    assert.strictEqual(config.reviewAfterPlan, true);
    assert.strictEqual(config.reviewInterval, 1);
  });
});
