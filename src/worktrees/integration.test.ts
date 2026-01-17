import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// src/worktrees/integration.test.ts
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorktreeManager } from './manager.js';

describe('Worktree Integration', () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'sq-integration-'));
    repoDir = join(testDir, 'repo');
    execSync(`mkdir -p ${repoDir}`, { stdio: 'pipe' });
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# Test\n');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('full lifecycle: create, work, merge, cleanup', async () => {
    const manager = new WorktreeManager({
      repoDir,
      worktreeBaseDir: join(repoDir, '.sq', 'worktrees'),
      baseBranch: 'main',
      runId: 'integration-test',
    });

    // Create worktree
    const { worktreePath } = await manager.create('loop-1');

    // Simulate agent work
    writeFileSync(join(worktreePath, 'feature.ts'), 'export const feature = true;\n');
    execSync('git add . && git commit -m "add feature"', { cwd: worktreePath, stdio: 'pipe' });

    // Merge
    const result = await manager.merge('loop-1');
    assert.strictEqual(result.status, 'success');

    // Verify merge on main
    const log = execSync('git log --oneline', { cwd: repoDir, stdio: 'pipe' });
    assert.ok(log.toString().includes('Merge loop-1'));

    // Cleanup
    await manager.cleanup('loop-1');

    // Verify cleanup
    const worktrees = execSync('git worktree list', { cwd: repoDir, stdio: 'pipe' });
    assert.ok(!worktrees.toString().includes('loop-1'));
  });

  it('handles multiple parallel worktrees', async () => {
    const manager = new WorktreeManager({
      repoDir,
      worktreeBaseDir: join(repoDir, '.sq', 'worktrees'),
      baseBranch: 'main',
      runId: 'parallel-test',
    });

    // Create multiple worktrees
    const wt1 = await manager.create('loop-a');
    const wt2 = await manager.create('loop-b');

    // Work in both (non-conflicting files)
    writeFileSync(join(wt1.worktreePath, 'file-a.ts'), 'export const a = 1;\n');
    execSync('git add . && git commit -m "add file-a"', { cwd: wt1.worktreePath, stdio: 'pipe' });

    writeFileSync(join(wt2.worktreePath, 'file-b.ts'), 'export const b = 2;\n');
    execSync('git add . && git commit -m "add file-b"', { cwd: wt2.worktreePath, stdio: 'pipe' });

    // Merge both
    const result1 = await manager.merge('loop-a');
    assert.strictEqual(result1.status, 'success');

    const result2 = await manager.merge('loop-b');
    assert.strictEqual(result2.status, 'success');

    // Verify both files exist on main
    const filesOnMain = execSync('git ls-tree --name-only HEAD', { cwd: repoDir, stdio: 'pipe' });
    assert.ok(filesOnMain.toString().includes('file-a.ts'));
    assert.ok(filesOnMain.toString().includes('file-b.ts'));

    // Cleanup all
    await manager.cleanupAll();
  });
});
