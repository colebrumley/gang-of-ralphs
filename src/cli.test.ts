import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseArgs } from './cli.js';

describe('CLI Argument Parsing', () => {
  test('parses required --spec argument', () => {
    const result = parseArgs(['--spec', 'spec.md']);
    assert.strictEqual(result.spec, 'spec.md');
  });

  test('parses --effort with default medium', () => {
    const result = parseArgs(['--spec', 'spec.md']);
    assert.strictEqual(result.effort, 'medium');
  });

  test('parses all options', () => {
    const result = parseArgs([
      '--spec', 'feature.md',
      '--effort', 'high',
      '--max-loops', '8',
      '--max-iterations', '30',
      '--state-dir', '.custom',
      '--reset'
    ]);

    assert.strictEqual(result.spec, 'feature.md');
    assert.strictEqual(result.effort, 'high');
    assert.strictEqual(result.maxLoops, 8);
    assert.strictEqual(result.maxIterations, 30);
    assert.strictEqual(result.stateDir, '.custom');
    assert.strictEqual(result.reset, true);
  });
});
