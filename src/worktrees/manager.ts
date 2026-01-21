// src/worktrees/manager.ts
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface WorktreeManagerConfig {
  repoDir: string;
  worktreeBaseDir: string;
  baseBranch: string;
  runId: string;
}

export interface CreateResult {
  worktreePath: string;
  branchName: string;
}

export type MergeResult = { status: 'success' } | { status: 'conflict'; conflictFiles: string[] };

export class WorktreeManager {
  private config: WorktreeManagerConfig;

  constructor(config: WorktreeManagerConfig) {
    this.config = config;
  }

  async create(loopId: string): Promise<CreateResult> {
    const branchName = `sq/${this.config.runId}/${loopId}`;
    const worktreePath = join(this.config.worktreeBaseDir, loopId);

    // Ensure base directory exists
    if (!existsSync(this.config.worktreeBaseDir)) {
      mkdirSync(this.config.worktreeBaseDir, { recursive: true });
    }

    // Create worktree with new branch
    await execAsync(
      `git worktree add -b "${branchName}" "${worktreePath}" "${this.config.baseBranch}"`,
      { cwd: this.config.repoDir }
    );

    return { worktreePath, branchName };
  }

  async merge(loopId: string): Promise<MergeResult> {
    const branchName = `sq/${this.config.runId}/${loopId}`;
    const worktreePath = join(this.config.worktreeBaseDir, loopId);

    // Commit any uncommitted changes in worktree
    try {
      await execAsync(
        `git add -A && git diff --cached --quiet || git commit -m "auto-commit before merge"`,
        { cwd: worktreePath }
      );
    } catch {
      // Ignore - may have nothing to commit
    }

    // Switch to base branch in main repo
    await execAsync(`git checkout "${this.config.baseBranch}"`, { cwd: this.config.repoDir });

    // Commit any untracked files in main repo that would conflict with the merge
    // This prevents "untracked working tree files would be overwritten by merge" errors
    try {
      // Get list of files that exist in the branch we're merging
      const { stdout: branchFiles } = await execAsync(
        `git diff --name-only "${this.config.baseBranch}"..."${branchName}"`,
        { cwd: this.config.repoDir }
      );
      const filesToCheck = branchFiles.trim().split('\n').filter(Boolean);

      if (filesToCheck.length > 0) {
        // Check which of these are untracked in main repo
        const { stdout: untrackedFiles } = await execAsync(
          'git ls-files --others --exclude-standard',
          { cwd: this.config.repoDir }
        );
        const untracked = new Set(untrackedFiles.trim().split('\n').filter(Boolean));

        // Find overlap - untracked files that would be created by merge
        const conflictingUntracked = filesToCheck.filter((f) => untracked.has(f));

        if (conflictingUntracked.length > 0) {
          // Stage and commit these files before merge to prevent conflict
          await execAsync(`git add ${conflictingUntracked.map((f) => `"${f}"`).join(' ')}`, {
            cwd: this.config.repoDir,
          });
          await execAsync(`git commit -m "auto-commit untracked files before merge"`, {
            cwd: this.config.repoDir,
          });
        }
      }
    } catch {
      // Ignore - best effort to prevent untracked file conflicts
    }

    // Attempt merge
    try {
      await execAsync(`git merge --no-ff "${branchName}" -m "Merge ${loopId}"`, {
        cwd: this.config.repoDir,
      });
      return { status: 'success' };
    } catch (e) {
      // Check for conflicts
      const { stdout } = await execAsync('git diff --name-only --diff-filter=U', {
        cwd: this.config.repoDir,
      });
      const conflictFiles = stdout.trim().split('\n').filter(Boolean);

      if (conflictFiles.length > 0) {
        return { status: 'conflict', conflictFiles };
      }

      // Re-throw if not a conflict error
      throw e;
    }
  }

  async cleanup(loopId: string): Promise<void> {
    const branchName = `sq/${this.config.runId}/${loopId}`;
    const worktreePath = join(this.config.worktreeBaseDir, loopId);

    // Remove worktree
    await execAsync(`git worktree remove "${worktreePath}" --force`, {
      cwd: this.config.repoDir,
    });

    // Delete branch
    try {
      await execAsync(`git branch -D "${branchName}"`, {
        cwd: this.config.repoDir,
      });
    } catch {
      // Branch may already be deleted
    }
  }

  async cleanupAll(): Promise<void> {
    const { stdout } = await execAsync('git worktree list --porcelain', {
      cwd: this.config.repoDir,
    });

    const lines = stdout.split('\n');

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const path = line.replace('worktree ', '');
        if (path.includes(this.config.worktreeBaseDir)) {
          const loopId = path.split('/').pop()!;
          await this.cleanup(loopId);
        }
      }
    }

    // Clean up empty worktree directory
    if (existsSync(this.config.worktreeBaseDir)) {
      rmSync(this.config.worktreeBaseDir, { recursive: true, force: true });
    }
  }
}
