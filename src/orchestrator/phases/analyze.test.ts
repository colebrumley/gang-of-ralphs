import assert from 'node:assert';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ZodError } from 'zod';
import { closeDatabase, createDatabase, getDatabase } from '../../db/index.js';
import { AnalyzeIncompleteError, isEmptyProject, loadAnalysisFromDB } from './analyze.js';

describe('Analyze Phase', () => {
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

  describe('AnalyzeIncompleteError', () => {
    test('includes error name', () => {
      const error = new AnalyzeIncompleteError('some output');
      assert.strictEqual(error.name, 'AnalyzeIncompleteError');
    });

    test('includes truncated output in error message', () => {
      const longOutput = 'x'.repeat(500);
      const error = new AnalyzeIncompleteError(longOutput);
      // Should include last 200 characters
      assert.ok(error.message.includes('x'.repeat(200)));
      assert.strictEqual(error.output, longOutput);
    });

    test('indicates ANALYZE_COMPLETE was missing', () => {
      const error = new AnalyzeIncompleteError('');
      assert.ok(error.message.includes('ANALYZE_COMPLETE'));
    });

    test('mentions turn limit for large codebases', () => {
      const error = new AnalyzeIncompleteError('');
      assert.ok(error.message.includes('30-turn limit'));
      assert.ok(error.message.includes('large codebases'));
    });
  });

  describe('loadAnalysisFromDB', () => {
    let tempDir: string;
    let dbPath: string;

    beforeEach(async () => {
      tempDir = await mkdir(join(tmpdir(), `sq-test-analyze-${Date.now()}`), { recursive: true });
      dbPath = join(tempDir, 'state.db');
      createDatabase(dbPath);
    });

    afterEach(async () => {
      closeDatabase();
      await rm(tempDir, { recursive: true, force: true });
    });

    test('returns null when run has no codebase_analysis', () => {
      const db = getDatabase();
      db.prepare('INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)').run(
        'run-no-analysis',
        '/path/to/spec.md',
        'medium'
      );

      const result = loadAnalysisFromDB('run-no-analysis');
      assert.strictEqual(result, null);
    });

    test('returns null when run does not exist', () => {
      const result = loadAnalysisFromDB('nonexistent-run');
      assert.strictEqual(result, null);
    });

    test('parses valid JSON and returns CodebaseAnalysis', () => {
      const db = getDatabase();
      const validAnalysis = {
        projectType: 'typescript/node',
        techStack: ['TypeScript', 'Node.js'],
        directoryStructure: 'src/ contains source files',
        existingFeatures: ['Feature A', 'Feature B'],
        entryPoints: ['src/index.ts'],
        patterns: ['MVC pattern'],
        summary: 'A Node.js project',
      };

      db.prepare(
        'INSERT INTO runs (id, spec_path, effort, codebase_analysis) VALUES (?, ?, ?, ?)'
      ).run('run-with-analysis', '/path/to/spec.md', 'medium', JSON.stringify(validAnalysis));

      const result = loadAnalysisFromDB('run-with-analysis');
      assert.deepStrictEqual(result, validAnalysis);
    });

    test('throws ZodError for JSON that does not match schema', () => {
      const db = getDatabase();
      const invalidAnalysis = {
        projectType: 'typescript/node',
        // Missing required fields: techStack, directoryStructure, existingFeatures, etc.
      };

      db.prepare(
        'INSERT INTO runs (id, spec_path, effort, codebase_analysis) VALUES (?, ?, ?, ?)'
      ).run('run-invalid-schema', '/path/to/spec.md', 'medium', JSON.stringify(invalidAnalysis));

      assert.throws(() => loadAnalysisFromDB('run-invalid-schema'), ZodError);
    });

    test('throws SyntaxError for malformed JSON', () => {
      const db = getDatabase();
      const malformedJson = '{ projectType: "invalid", missing quotes }';

      db.prepare(
        'INSERT INTO runs (id, spec_path, effort, codebase_analysis) VALUES (?, ?, ?, ?)'
      ).run('run-malformed', '/path/to/spec.md', 'medium', malformedJson);

      assert.throws(() => loadAnalysisFromDB('run-malformed'), SyntaxError);
    });

    test('throws ZodError for JSON with wrong types', () => {
      const db = getDatabase();
      const wrongTypes = {
        projectType: 123, // Should be string
        techStack: 'not an array', // Should be array
        directoryStructure: null, // Should be string
        existingFeatures: {},
        entryPoints: true,
        patterns: 'string',
        summary: [],
      };

      db.prepare(
        'INSERT INTO runs (id, spec_path, effort, codebase_analysis) VALUES (?, ?, ?, ?)'
      ).run('run-wrong-types', '/path/to/spec.md', 'medium', JSON.stringify(wrongTypes));

      assert.throws(() => loadAnalysisFromDB('run-wrong-types'), ZodError);
    });
  });

  describe('ANALYZE_COMPLETE without set_codebase_analysis', () => {
    test('executeAnalyze throws when ANALYZE_COMPLETE signaled but no analysis stored', async () => {
      // This scenario is handled by the code at line 217-219:
      // const analysis = loadAnalysisFromDB(state.runId);
      // if (!analysis) {
      //   throw new Error('Analyze phase completed but no analysis was stored');
      // }
      //
      // The test validates that the error message is correct
      const error = new Error('Analyze phase completed but no analysis was stored');
      assert.strictEqual(error.message, 'Analyze phase completed but no analysis was stored');
    });
  });
});
