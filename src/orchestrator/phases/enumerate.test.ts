import assert from 'node:assert';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isEmptyProject } from './analyze.js';
import {
  EnumerateIncompleteError,
  formatCodebaseAnalysis,
  validateTaskGranularity,
} from './enumerate.js';

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

describe('EnumerateIncompleteError', () => {
  test('includes task count in error message', () => {
    const error = new EnumerateIncompleteError(3, 'some output');
    assert.ok(error.message.includes('3 partial tasks'));
    assert.strictEqual(error.taskCount, 3);
  });

  test('includes truncated output in error message', () => {
    const longOutput = 'x'.repeat(500);
    const error = new EnumerateIncompleteError(0, longOutput);
    // Should include last 200 characters
    assert.ok(error.message.includes('x'.repeat(200)));
    assert.strictEqual(error.output, longOutput);
  });

  test('has correct error name', () => {
    const error = new EnumerateIncompleteError(0, '');
    assert.strictEqual(error.name, 'EnumerateIncompleteError');
  });

  test('indicates ENUMERATE_COMPLETE was missing', () => {
    const error = new EnumerateIncompleteError(0, '');
    assert.ok(error.message.includes('ENUMERATE_COMPLETE'));
  });
});

describe('Analyze → Enumerate Integration', () => {
  describe('formatCodebaseAnalysis', () => {
    test('returns EMPTY_PROJECT_ANALYSIS for null analysis', () => {
      const result = formatCodebaseAnalysis(null);
      assert.ok(result.includes('new/empty project'));
      assert.ok(result.includes('built from scratch'));
    });

    test('returns EMPTY_PROJECT_ANALYSIS for empty/greenfield projectType', () => {
      const emptyAnalysis = {
        projectType: 'empty/greenfield',
        techStack: [],
        directoryStructure: '',
        existingFeatures: [],
        entryPoints: [],
        patterns: [],
        summary: 'Empty project',
      };
      const result = formatCodebaseAnalysis(emptyAnalysis);
      assert.ok(result.includes('new/empty project'));
      assert.ok(result.includes('built from scratch'));
    });

    test('injects codebase analysis fields into template', () => {
      const analysis = {
        projectType: 'typescript/node',
        techStack: ['TypeScript', 'Node.js', 'Jest'],
        directoryStructure: 'src/ for source, tests/ for tests',
        existingFeatures: ['User authentication', 'Database connection'],
        entryPoints: ['src/index.ts', 'src/cli.ts'],
        patterns: ['Singleton pattern for DB', 'Factory pattern for services'],
        summary: 'A Node.js backend service with user management.',
      };

      const result = formatCodebaseAnalysis(analysis);

      // Verify all fields are injected
      assert.ok(result.includes('typescript/node'), 'Should include projectType');
      assert.ok(result.includes('TypeScript, Node.js, Jest'), 'Should include joined techStack');
      assert.ok(
        result.includes('src/ for source, tests/ for tests'),
        'Should include directoryStructure'
      );
      assert.ok(
        result.includes('- User authentication'),
        'Should format existing features as list'
      );
      assert.ok(result.includes('- Database connection'), 'Should include all existing features');
      assert.ok(result.includes('src/index.ts, src/cli.ts'), 'Should include joined entryPoints');
      assert.ok(result.includes('- Singleton pattern for DB'), 'Should format patterns as list');
      assert.ok(result.includes('- Factory pattern for services'), 'Should include all patterns');
      assert.ok(
        result.includes('A Node.js backend service with user management.'),
        'Should include summary'
      );
      assert.ok(
        result.includes('avoid creating tasks for functionality that already exists'),
        'Should include instruction to avoid duplicating existing features'
      );
    });

    test('handles empty arrays gracefully', () => {
      const analysis = {
        projectType: 'python/django',
        techStack: [],
        directoryStructure: 'app/ contains Django app',
        existingFeatures: [],
        entryPoints: [],
        patterns: [],
        summary: 'A Django project.',
      };

      const result = formatCodebaseAnalysis(analysis);

      // Should show "None" or similar for empty arrays
      assert.ok(result.includes('python/django'), 'Should include projectType');
      assert.ok(
        result.includes('None detected') || result.includes('None'),
        'Should handle empty techStack'
      );
    });
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
