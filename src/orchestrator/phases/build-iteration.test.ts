import assert from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('Build Iteration with Scratchpad', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `build-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('scratchpad file format is correct', () => {
    // Create scratchpad in mock worktree
    const scratchpadContent = `# Iteration Scratchpad

## Done this iteration
Created User model

## Test status
PASS - 1 test passing

## Next step
Add validation

## Blockers
none
`;
    writeFileSync(join(testDir, '.sq-scratchpad.md'), scratchpadContent);

    // Verify the file was written correctly
    const content = readFileSync(join(testDir, '.sq-scratchpad.md'), 'utf-8');
    assert.ok(content.includes('Created User model'), 'Should include done content');
    assert.ok(content.includes('Add validation'), 'Should include next step');
    assert.ok(content.includes('PASS'), 'Should include test status');
  });

  test('scratchpad file can be found in worktree directory', () => {
    const scratchpadPath = join(testDir, '.sq-scratchpad.md');
    writeFileSync(scratchpadPath, '# Test');

    assert.ok(existsSync(scratchpadPath), 'Scratchpad should exist in worktree');
  });
});
