/**
 * Integration tests for ANALYZE phase behavior
 *
 * These tests verify the expected behavior of the ANALYZE phase:
 * 1. Empty projects should be detected correctly and skip agent invocation
 * 2. Codebase analysis should be stored in the unified context table
 * 3. Analysis should be retrievable and have the correct schema
 *
 * Note: Full agent invocation is tested via MockAgentFactory (when implemented).
 * These tests focus on the data layer and helper function contracts.
 */
import assert from 'node:assert';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ZodError } from 'zod';
import { writeContextToDb } from '../../db/context.js';
import { closeDatabase, createDatabase, getDatabase } from '../../db/index.js';
import { isEmptyProject, loadAnalysisFromDB } from '../../orchestrator/phases/analyze.js';
import type { CodebaseAnalysis } from '../../types/index.js';

describe('ANALYZE Phase Integration', () => {
  let tempDir: string;
  let dbPath: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `sq-integration-analyze-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempDir, { recursive: true });
    dbPath = join(tempDir, 'state.db');
    projectDir = join(tempDir, 'project');
    await mkdir(projectDir, { recursive: true });
    createDatabase(dbPath);

    // Create a run entry for tests
    const db = getDatabase();
    db.prepare('INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)').run(
      'test-run',
      '/path/to/spec.md',
      'medium'
    );
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Empty Project Detection (isEmptyProject)', () => {
    /**
     * SPEC: Empty project detection should identify directories that have no
     * meaningful code to analyze, so the ANALYZE phase can skip expensive
     * agent invocation and provide a standard "greenfield" analysis.
     */

    test('SPEC: empty directory should be detected as empty project', async () => {
      // An empty directory has nothing to analyze
      const result = await isEmptyProject(projectDir, '/external/spec.md');
      assert.strictEqual(result, true);
    });

    test('SPEC: .git and .gitignore should be ignored (common in new repos)', async () => {
      // New git repos have .git folder - this should not trigger analysis
      await mkdir(join(projectDir, '.git'), { recursive: true });
      await writeFile(join(projectDir, '.gitignore'), 'node_modules\n');

      const result = await isEmptyProject(projectDir, '/external/spec.md');
      assert.strictEqual(result, true);
    });

    test('SPEC: spec file itself should not count as project content', async () => {
      // The spec file is input, not existing project content
      const specPath = join(projectDir, 'spec.md');
      await writeFile(specPath, '# My Specification\n\nBuild a todo app.');

      const result = await isEmptyProject(projectDir, specPath);
      assert.strictEqual(result, true);
    });

    test('SPEC: .sq state directory should be ignored', async () => {
      // The orchestrator's own state should not count as project content
      await mkdir(join(projectDir, '.sq'), { recursive: true });
      await writeFile(join(projectDir, '.sq', 'state.db'), '');

      const result = await isEmptyProject(projectDir, '/external/spec.md');
      assert.strictEqual(result, true);
    });

    test('SPEC: any source file should trigger populated detection', async () => {
      // Even a single source file means there's code to analyze
      await writeFile(join(projectDir, 'index.ts'), 'console.log("hello");');

      const result = await isEmptyProject(projectDir, '/external/spec.md');
      assert.strictEqual(result, false);
    });

    test('SPEC: package.json indicates a real project', async () => {
      // Package manifests indicate an initialized project
      await writeFile(join(projectDir, 'package.json'), '{"name": "test"}');

      const result = await isEmptyProject(projectDir, '/external/spec.md');
      assert.strictEqual(result, false);
    });

    test('SPEC: pyproject.toml indicates a real project', async () => {
      await writeFile(join(projectDir, 'pyproject.toml'), '[project]\nname = "test"');

      const result = await isEmptyProject(projectDir, '/external/spec.md');
      assert.strictEqual(result, false);
    });

    test('SPEC: non-existent directory should fail safely', async () => {
      // Defensive: don't crash on missing directories
      const result = await isEmptyProject('/nonexistent/path/12345', '/spec.md');
      assert.strictEqual(result, false);
    });
  });

  describe('Codebase Analysis Storage', () => {
    /**
     * SPEC: Codebase analysis should be stored in the unified context table
     * with type='codebase_analysis'. This enables consistent querying and
     * supports the context system's features (FTS, filtering, etc).
     */

    test('SPEC: analysis stored via write_context should be retrievable', async () => {
      const db = getDatabase();
      const analysis: CodebaseAnalysis = {
        projectType: 'typescript/node',
        techStack: ['TypeScript', 'Node.js'],
        directoryStructure: 'src/ contains modules',
        existingFeatures: ['CLI interface'],
        entryPoints: ['src/index.ts'],
        patterns: ['ES modules'],
        summary: 'A TypeScript CLI application.',
      };

      // Store via the unified context system (as MCP tool would)
      writeContextToDb(db, {
        runId: 'test-run',
        type: 'codebase_analysis',
        content: JSON.stringify(analysis),
      });

      // Verify retrieval
      const loaded = loadAnalysisFromDB('test-run');
      assert.deepStrictEqual(loaded, analysis);
    });

    test('SPEC: missing analysis should return null, not throw', async () => {
      // No analysis stored yet
      const loaded = loadAnalysisFromDB('test-run');
      assert.strictEqual(loaded, null);
    });

    test('SPEC: invalid JSON should throw parse error', async () => {
      const db = getDatabase();
      db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(
        'test-run',
        'codebase_analysis',
        'not valid json{'
      );

      assert.throws(() => loadAnalysisFromDB('test-run'), SyntaxError);
    });

    test('SPEC: analysis missing required fields should throw validation error', async () => {
      const db = getDatabase();
      // Missing required fields like techStack, patterns, etc.
      const invalidAnalysis = {
        projectType: 'typescript',
        summary: 'Missing fields',
      };

      db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(
        'test-run',
        'codebase_analysis',
        JSON.stringify(invalidAnalysis)
      );

      assert.throws(() => loadAnalysisFromDB('test-run'), ZodError);
    });

    test('SPEC: backwards compatibility with runs table codebase_analysis column', async () => {
      const db = getDatabase();
      const analysis: CodebaseAnalysis = {
        projectType: 'python',
        techStack: ['Python'],
        directoryStructure: 'app/',
        existingFeatures: [],
        entryPoints: ['app/main.py'],
        patterns: [],
        summary: 'A Python application.',
      };

      // Old storage location (runs table)
      db.prepare('UPDATE runs SET codebase_analysis = ? WHERE id = ?').run(
        JSON.stringify(analysis),
        'test-run'
      );

      // Should still be loadable
      const loaded = loadAnalysisFromDB('test-run');
      assert.deepStrictEqual(loaded, analysis);
    });

    test('SPEC: context table takes precedence over runs table', async () => {
      const db = getDatabase();
      const runsAnalysis: CodebaseAnalysis = {
        projectType: 'old-from-runs',
        techStack: [],
        directoryStructure: '',
        existingFeatures: [],
        entryPoints: [],
        patterns: [],
        summary: 'Old',
      };
      const contextAnalysis: CodebaseAnalysis = {
        projectType: 'new-from-context',
        techStack: ['New'],
        directoryStructure: 'New structure',
        existingFeatures: ['New feature'],
        entryPoints: ['new.ts'],
        patterns: ['New pattern'],
        summary: 'New and improved analysis.',
      };

      // Store in both locations
      db.prepare('UPDATE runs SET codebase_analysis = ? WHERE id = ?').run(
        JSON.stringify(runsAnalysis),
        'test-run'
      );
      writeContextToDb(db, {
        runId: 'test-run',
        type: 'codebase_analysis',
        content: JSON.stringify(contextAnalysis),
      });

      // Context table should win
      const loaded = loadAnalysisFromDB('test-run');
      assert.strictEqual(loaded?.projectType, 'new-from-context');
    });
  });

  describe('Analysis Schema Validation', () => {
    /**
     * SPEC: CodebaseAnalysis must have all required fields with correct types.
     * This ensures the ENUMERATE phase receives consistent, usable data.
     */

    test('SPEC: all required fields must be present', async () => {
      const db = getDatabase();

      // Each field missing should cause validation error
      const fieldTests = [
        { omit: 'projectType', error: 'projectType' },
        { omit: 'techStack', error: 'techStack' },
        { omit: 'directoryStructure', error: 'directoryStructure' },
        { omit: 'existingFeatures', error: 'existingFeatures' },
        { omit: 'entryPoints', error: 'entryPoints' },
        { omit: 'patterns', error: 'patterns' },
        { omit: 'summary', error: 'summary' },
      ];

      for (const { omit } of fieldTests) {
        const analysis: Record<string, unknown> = {
          projectType: 'test',
          techStack: [],
          directoryStructure: 'test',
          existingFeatures: [],
          entryPoints: [],
          patterns: [],
          summary: 'test',
        };
        delete analysis[omit];

        // Clear previous entry
        db.prepare("DELETE FROM context WHERE run_id = ? AND type = 'codebase_analysis'").run(
          'test-run'
        );
        db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(
          'test-run',
          'codebase_analysis',
          JSON.stringify(analysis)
        );

        assert.throws(
          () => loadAnalysisFromDB('test-run'),
          ZodError,
          `Missing ${omit} should throw ZodError`
        );
      }
    });

    test('SPEC: array fields must be arrays', async () => {
      const db = getDatabase();
      const analysis = {
        projectType: 'test',
        techStack: 'not an array', // Should be array
        directoryStructure: 'test',
        existingFeatures: [],
        entryPoints: [],
        patterns: [],
        summary: 'test',
      };

      db.prepare('INSERT INTO context (run_id, type, content) VALUES (?, ?, ?)').run(
        'test-run',
        'codebase_analysis',
        JSON.stringify(analysis)
      );

      assert.throws(() => loadAnalysisFromDB('test-run'), ZodError);
    });
  });
});
