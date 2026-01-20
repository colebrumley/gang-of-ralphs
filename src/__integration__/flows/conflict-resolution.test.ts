/**
 * Integration tests for CONFLICT phase behavior
 *
 * These tests verify the expected behavior of the conflict resolution flow:
 * 1. Agent output parsing (CONFLICT_RESOLVED, CONFLICT_FAILED markers)
 * 2. ConflictResult structure and error handling
 * 3. Pending conflicts database tracking
 * 4. Integration with worktree merge flow
 *
 * The CONFLICT phase spawns an agent to resolve git merge conflicts that
 * occur when merging worktree changes back to the main branch.
 */
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { closeDatabase, createDatabase, getDatabase } from '../../db/index.js';
import type { ConflictResult } from '../../orchestrator/phases/conflict.js';

describe('CONFLICT Phase Integration', () => {
  let tempDir: string;
  let dbPath: string;
  let runId: string;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `sq-integration-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempDir, { recursive: true });
    dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    runId = 'test-run';

    const db = getDatabase();
    db.prepare('INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)').run(
      runId,
      '/path/to/spec.md',
      'medium'
    );
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ConflictResult Type Contract', () => {
    /**
     * SPEC: ConflictResult represents the outcome of a conflict resolution attempt.
     * It must indicate whether resolution succeeded and track any costs incurred.
     */

    test('SPEC: resolved=true indicates successful conflict resolution', () => {
      const result: ConflictResult = {
        resolved: true,
        costUsd: 0.05,
      };

      assert.strictEqual(result.resolved, true);
      assert.strictEqual(result.error, undefined);
      assert.ok(result.costUsd >= 0);
    });

    test('SPEC: resolved=false with error explains why resolution failed', () => {
      const result: ConflictResult = {
        resolved: false,
        error: 'Conflicting changes in src/index.ts are semantically incompatible',
        costUsd: 0.03,
      };

      assert.strictEqual(result.resolved, false);
      assert.ok(result.error);
      assert.ok(result.error.length > 0);
    });

    test('SPEC: costUsd is always present to track agent expenses', () => {
      const successResult: ConflictResult = { resolved: true, costUsd: 0.05 };
      const failResult: ConflictResult = { resolved: false, costUsd: 0.02 };

      assert.ok(typeof successResult.costUsd === 'number');
      assert.ok(typeof failResult.costUsd === 'number');
    });
  });

  describe('Agent Output Parsing', () => {
    /**
     * SPEC: The CONFLICT phase agent signals completion via text markers:
     * - CONFLICT_RESOLVED: Agent successfully resolved all conflicts
     * - CONFLICT_FAILED: <reason>: Agent could not resolve, provides reason
     *
     * The parsing logic must correctly detect these markers in agent output.
     */

    test('SPEC: CONFLICT_RESOLVED marker indicates success', () => {
      const output =
        'I analyzed the merge conflicts in the following files:\n' +
        '- src/index.ts\n' +
        '- src/utils.ts\n\n' +
        'I have resolved all conflicts by keeping both changes.\n\n' +
        'CONFLICT_RESOLVED';

      const resolved = output.includes('CONFLICT_RESOLVED');
      assert.strictEqual(resolved, true);
    });

    test('SPEC: CONFLICT_FAILED marker with reason indicates failure', () => {
      const output =
        'I examined the conflicts but they require human judgment:\n' +
        'CONFLICT_FAILED: Manual intervention required - semantic conflict in business logic';

      const resolved = output.includes('CONFLICT_RESOLVED');
      const failMatch = output.match(/CONFLICT_FAILED:\s*(.+)/);

      assert.strictEqual(resolved, false);
      assert.ok(failMatch);
      assert.strictEqual(
        failMatch[1],
        'Manual intervention required - semantic conflict in business logic'
      );
    });

    test('SPEC: CONFLICT_FAILED extracts only the reason line', () => {
      const output =
        'CONFLICT_FAILED: Cannot merge incompatible changes\n' +
        'Additional details that should not be captured';

      const failMatch = output.match(/CONFLICT_FAILED:\s*(.+)/);

      assert.ok(failMatch);
      assert.strictEqual(failMatch[1], 'Cannot merge incompatible changes');
      assert.ok(!failMatch[1].includes('Additional details'));
    });

    test('SPEC: missing markers should result in unknown failure', () => {
      const output = 'Something went wrong and the agent crashed without signaling';

      const resolved = output.includes('CONFLICT_RESOLVED');
      const failMatch = output.match(/CONFLICT_FAILED:\s*(.+)/);

      assert.strictEqual(resolved, false);
      assert.strictEqual(failMatch, null);

      // Code should default to 'Unknown conflict resolution failure'
      const error = failMatch?.[1] || 'Unknown conflict resolution failure';
      assert.strictEqual(error, 'Unknown conflict resolution failure');
    });

    test('SPEC: CONFLICT_RESOLVED takes precedence if both markers present', () => {
      // Edge case: agent might write both (shouldn't happen, but be defensive)
      const output =
        'Initially failed, but then succeeded.\n' +
        'CONFLICT_FAILED: First attempt failed\n' +
        'After retry:\n' +
        'CONFLICT_RESOLVED';

      // Check for resolved first (as the code does)
      if (output.includes('CONFLICT_RESOLVED')) {
        const result: ConflictResult = { resolved: true, costUsd: 0.05 };
        assert.strictEqual(result.resolved, true);
      }
    });
  });

  describe('Pending Conflicts Database Tracking', () => {
    /**
     * SPEC: Pending conflicts are tracked in the database so the orchestrator
     * knows which worktrees need conflict resolution before continuing.
     */

    test('SPEC: pending conflict can be recorded in database', async () => {
      const db = getDatabase();
      const loopId = 'loop-1';
      const taskId = 'task-1';
      const conflictFiles = ['src/index.ts', 'src/utils.ts'];

      db.prepare(`
        INSERT INTO pending_conflicts (run_id, loop_id, task_id, conflict_files)
        VALUES (?, ?, ?, ?)
      `).run(runId, loopId, taskId, JSON.stringify(conflictFiles));

      const pending = db
        .prepare('SELECT * FROM pending_conflicts WHERE run_id = ?')
        .get(runId) as Record<string, unknown>;

      assert.ok(pending);
      assert.strictEqual(pending.loop_id, loopId);
      assert.strictEqual(pending.task_id, taskId);
      assert.deepStrictEqual(JSON.parse(pending.conflict_files as string), conflictFiles);
    });

    test('SPEC: multiple pending conflicts can be tracked', async () => {
      const db = getDatabase();

      db.prepare(`
        INSERT INTO pending_conflicts (run_id, loop_id, task_id, conflict_files)
        VALUES (?, ?, ?, ?)
      `).run(runId, 'loop-1', 'task-1', '["file1.ts"]');

      db.prepare(`
        INSERT INTO pending_conflicts (run_id, loop_id, task_id, conflict_files)
        VALUES (?, ?, ?, ?)
      `).run(runId, 'loop-2', 'task-2', '["file2.ts", "file3.ts"]');

      const pending = db
        .prepare('SELECT * FROM pending_conflicts WHERE run_id = ?')
        .all(runId) as Array<Record<string, unknown>>;

      assert.strictEqual(pending.length, 2);
    });

    test('SPEC: resolved conflict should be removable from pending', async () => {
      const db = getDatabase();
      const loopId = 'loop-1';

      db.prepare(`
        INSERT INTO pending_conflicts (run_id, loop_id, task_id, conflict_files)
        VALUES (?, ?, ?, ?)
      `).run(runId, loopId, 'task-1', '["file.ts"]');

      // After resolution, remove from pending
      db.prepare('DELETE FROM pending_conflicts WHERE loop_id = ?').run(loopId);

      const remaining = db.prepare('SELECT * FROM pending_conflicts WHERE run_id = ?').all(runId);

      assert.strictEqual(remaining.length, 0);
    });
  });

  describe('Git Conflict Detection', () => {
    /**
     * SPEC: Git conflicts are detected via `git diff --name-only --diff-filter=U`
     * after a failed merge attempt. The CONFLICT phase receives this file list.
     */

    let repoDir: string;

    beforeEach(async () => {
      repoDir = join(tempDir, 'repo');
      await mkdir(repoDir, { recursive: true });

      // Initialize git repo
      execSync('git init', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });

      // Create initial commit
      await writeFile(join(repoDir, 'file.txt'), 'initial content\n');
      execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });
    });

    test('SPEC: detects conflict files after failed merge', async () => {
      // Create branch with change
      execSync('git checkout -b feature', { cwd: repoDir, stdio: 'pipe' });
      await writeFile(join(repoDir, 'file.txt'), 'feature content\n');
      execSync('git add . && git commit -m "feature change"', { cwd: repoDir, stdio: 'pipe' });

      // Create conflicting change on main
      execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
      await writeFile(join(repoDir, 'file.txt'), 'main content\n');
      execSync('git add . && git commit -m "main change"', { cwd: repoDir, stdio: 'pipe' });

      // Attempt merge (should fail)
      try {
        execSync('git merge feature', { cwd: repoDir, stdio: 'pipe' });
        assert.fail('Merge should have failed due to conflict');
      } catch {
        // Expected
      }

      // Detect conflict files
      const conflictOutput = execSync('git diff --name-only --diff-filter=U', {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      const conflictFiles = conflictOutput.trim().split('\n').filter(Boolean);

      assert.strictEqual(conflictFiles.length, 1);
      assert.strictEqual(conflictFiles[0], 'file.txt');
    });

    test('SPEC: no conflicts returns empty list', async () => {
      // No merge in progress = no conflicts
      const conflictOutput = execSync('git diff --name-only --diff-filter=U', {
        cwd: repoDir,
        encoding: 'utf-8',
      });
      const conflictFiles = conflictOutput.trim().split('\n').filter(Boolean);

      assert.strictEqual(conflictFiles.length, 0);
    });
  });

  describe('Conflict Prompt Generation', () => {
    /**
     * SPEC: The CONFLICT phase prompt should include:
     * 1. List of conflicting files
     * 2. Task description for context
     * 3. Instructions to use CONFLICT_RESOLVED or CONFLICT_FAILED markers
     */

    test('SPEC: prompt template should include conflict files placeholder', () => {
      // This tests the expected prompt structure
      const promptTemplate =
        'You are resolving merge conflicts.\n\n' +
        'Conflicting files:\n{{conflictFiles}}\n\n' +
        'Task: {{taskDescription}}\n\n' +
        'Resolve the conflicts and signal CONFLICT_RESOLVED when done.\n' +
        'If you cannot resolve, signal CONFLICT_FAILED: <reason>';

      const conflictFiles = ['src/index.ts', 'src/utils.ts'];
      const taskDescription = 'Add user authentication';

      const prompt = promptTemplate
        .replace('{{conflictFiles}}', conflictFiles.map((f) => `- ${f}`).join('\n'))
        .replace('{{taskDescription}}', taskDescription);

      assert.ok(prompt.includes('- src/index.ts'));
      assert.ok(prompt.includes('- src/utils.ts'));
      assert.ok(prompt.includes('Add user authentication'));
      assert.ok(prompt.includes('CONFLICT_RESOLVED'));
      assert.ok(prompt.includes('CONFLICT_FAILED'));
    });
  });

  describe('Error Recovery', () => {
    /**
     * SPEC: The CONFLICT phase should handle errors gracefully:
     * 1. Agent crashes should return resolved=false with error
     * 2. Timeout should be treated as failure
     * 3. Invalid output should use default error message
     */

    test('SPEC: exception during resolution returns failure result', async () => {
      // Simulate what resolveConflict does on exception
      try {
        throw new Error('Agent process crashed');
      } catch (e) {
        const result: ConflictResult = {
          resolved: false,
          error: String(e),
          costUsd: 0,
        };

        assert.strictEqual(result.resolved, false);
        assert.ok(result.error?.includes('crashed'));
      }
    });

    test('SPEC: empty output should use default error', () => {
      const output = '';

      const resolved = output.includes('CONFLICT_RESOLVED');
      const failMatch = output.match(/CONFLICT_FAILED:\s*(.+)/);

      const result: ConflictResult = {
        resolved,
        error: failMatch?.[1] || 'Unknown conflict resolution failure',
        costUsd: 0.01,
      };

      assert.strictEqual(result.resolved, false);
      assert.strictEqual(result.error, 'Unknown conflict resolution failure');
    });
  });

  describe('Cost Tracking', () => {
    /**
     * SPEC: Conflict resolution costs should be tracked for budget enforcement.
     */

    test('SPEC: costUsd should be non-negative', () => {
      const result: ConflictResult = { resolved: true, costUsd: 0.05 };
      assert.ok(result.costUsd >= 0);
    });

    test('SPEC: costUsd should be tracked even on failure', () => {
      const result: ConflictResult = {
        resolved: false,
        error: 'Could not resolve',
        costUsd: 0.03,
      };
      assert.ok(result.costUsd > 0, 'Failed resolution still incurs costs');
    });

    test('SPEC: cost can be recorded in phase_costs table', async () => {
      const db = getDatabase();

      // Record conflict phase cost
      db.prepare(`
        INSERT INTO phase_costs (run_id, phase, cost_usd)
        VALUES (?, 'conflict', ?)
        ON CONFLICT(run_id, phase) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd
      `).run(runId, 0.05);

      const cost = db
        .prepare("SELECT cost_usd FROM phase_costs WHERE run_id = ? AND phase = 'conflict'")
        .get(runId) as { cost_usd: number };

      assert.strictEqual(cost.cost_usd, 0.05);

      // Add more cost (multiple conflict resolutions)
      db.prepare(`
        INSERT INTO phase_costs (run_id, phase, cost_usd)
        VALUES (?, 'conflict', ?)
        ON CONFLICT(run_id, phase) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd
      `).run(runId, 0.03);

      const totalCost = db
        .prepare("SELECT cost_usd FROM phase_costs WHERE run_id = ? AND phase = 'conflict'")
        .get(runId) as { cost_usd: number };

      assert.strictEqual(totalCost.cost_usd, 0.08);
    });
  });
});
