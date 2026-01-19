import assert from 'node:assert';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isEmptyProject, validateTaskGranularity } from './enumerate.js';

describe('Enumerate Phase', () => {
  // NOTE: Task creation now happens via MCP tools (write_task)
  // The loadTasksFromDB function reads from the database after agent runs
  // Integration tests should verify MCP tool usage

  // Risk #5 mitigation: Task granularity validation
  test('validateTaskGranularity warns on too-large tasks', () => {
    const tasks = [
      {
        id: 't1',
        title: 'Huge task',
        description: 'Everything that needs doing',
        status: 'pending' as const,
        dependencies: [],
        estimatedIterations: 50,
        assignedLoopId: null,
      },
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some((w) => w.includes('too large')));
  });

  test('validateTaskGranularity warns on too-small tasks', () => {
    const tasks = [
      {
        id: 't1',
        title: 'Tiny',
        description: 'A very small task description',
        status: 'pending' as const,
        dependencies: [],
        estimatedIterations: 1,
        assignedLoopId: null,
      },
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some((w) => w.includes('too small')));
  });

  test('validateTaskGranularity warns on short descriptions', () => {
    const tasks = [
      {
        id: 't1',
        title: 'Task',
        description: 'x',
        status: 'pending' as const,
        dependencies: [],
        estimatedIterations: 10,
        assignedLoopId: null,
      },
    ];
    const result = validateTaskGranularity(tasks);
    assert.ok(result.warnings.some((w) => w.includes('short description')));
  });

  test('validateTaskGranularity passes for well-sized tasks', () => {
    const tasks = [
      {
        id: 't1',
        title: 'Good task',
        description: 'A reasonably detailed task description',
        status: 'pending' as const,
        dependencies: [],
        estimatedIterations: 10,
        assignedLoopId: null,
      },
    ];
    const result = validateTaskGranularity(tasks);
    assert.strictEqual(result.warnings.length, 0);
    assert.strictEqual(result.valid, true);
  });
});

describe('isEmptyProject', () => {
  test('returns true for empty directory', async () => {
    const testDir = join(tmpdir(), `sq-test-empty-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    try {
      const result = await isEmptyProject(testDir, '/some/spec.md');
      assert.strictEqual(result, true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns true for directory with only ignored files', async () => {
    const testDir = join(tmpdir(), `sq-test-ignored-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, '.git'), { recursive: true });
    await mkdir(join(testDir, '.sq'), { recursive: true });
    await writeFile(join(testDir, '.gitignore'), 'node_modules\n');
    try {
      const result = await isEmptyProject(testDir, '/some/spec.md');
      assert.strictEqual(result, true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns true for directory with only spec file', async () => {
    const testDir = join(tmpdir(), `sq-test-spec-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const specPath = join(testDir, 'spec.md');
    await writeFile(specPath, '# Spec');
    try {
      const result = await isEmptyProject(testDir, specPath);
      assert.strictEqual(result, true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns false for directory with source files', async () => {
    const testDir = join(tmpdir(), `sq-test-src-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'index.ts'), 'console.log("hello")');
    try {
      const result = await isEmptyProject(testDir, '/some/spec.md');
      assert.strictEqual(result, false);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns false for directory with package.json', async () => {
    const testDir = join(tmpdir(), `sq-test-pkg-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'package.json'), '{}');
    try {
      const result = await isEmptyProject(testDir, '/some/spec.md');
      assert.strictEqual(result, false);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns false for non-existent directory', async () => {
    const result = await isEmptyProject('/nonexistent/path', '/some/spec.md');
    assert.strictEqual(result, false);
  });
});
