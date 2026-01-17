// src/worktrees/manager.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeManager } from './manager.js';

describe('WorktreeManager', () => {
  let testDir: string;
  let repoDir: string;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    // Create temp directory with a git repo
    testDir = mkdtempSync(join(tmpdir(), 'c2-worktree-test-'));
    repoDir = join(testDir, 'repo');
    execSync(`mkdir -p ${repoDir} && cd ${repoDir} && git init && git commit --allow-empty -m "init"`, { stdio: 'pipe' });

    worktreeManager = new WorktreeManager({
      repoDir,
      worktreeBaseDir: join(repoDir, '.c2', 'worktrees'),
      baseBranch: 'main',
      runId: 'test-run-123',
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('create()', () => {
    it('creates a worktree directory', async () => {
      const result = await worktreeManager.create('loop-abc');

      assert.ok(result.worktreePath.includes('loop-abc'));
      assert.ok(result.branchName.includes('c2/test-run-123/loop-abc'));
    });
  });

  describe('merge()', () => {
    it('merges worktree branch to base branch', async () => {
      // Create worktree
      const { worktreePath, branchName } = await worktreeManager.create('loop-merge');

      // Make a change in the worktree
      execSync(`echo "test content" > test.txt && git add test.txt && git commit -m "add test"`, {
        cwd: worktreePath,
        stdio: 'pipe',
      });

      // Merge back
      const result = await worktreeManager.merge('loop-merge');

      assert.strictEqual(result.status, 'success');

      // Verify file exists on base branch
      const fileExists = execSync(`git show main:test.txt`, { cwd: repoDir, stdio: 'pipe' });
      assert.ok(fileExists.toString().includes('test content'));
    });

    it('detects merge conflicts', async () => {
      // Create worktree
      const { worktreePath } = await worktreeManager.create('loop-conflict');

      // Make a change in the worktree
      execSync(`echo "worktree change" > conflict.txt && git add conflict.txt && git commit -m "worktree"`, {
        cwd: worktreePath,
        stdio: 'pipe',
      });

      // Make conflicting change on base branch
      execSync(`echo "base change" > conflict.txt && git add conflict.txt && git commit -m "base"`, {
        cwd: repoDir,
        stdio: 'pipe',
      });

      // Attempt merge
      const result = await worktreeManager.merge('loop-conflict');

      assert.strictEqual(result.status, 'conflict');
      assert.ok(result.conflictFiles.includes('conflict.txt'));
    });
  });
});
