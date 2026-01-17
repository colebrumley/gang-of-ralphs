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

export type MergeResult =
  | { status: 'success' }
  | { status: 'conflict'; conflictFiles: string[] };

export class WorktreeManager {
  private config: WorktreeManagerConfig;

  constructor(config: WorktreeManagerConfig) {
    this.config = config;
  }

  async create(loopId: string): Promise<CreateResult> {
    const branchName = `c2/${this.config.runId}/${loopId}`;
    const worktreePath = join(this.config.worktreeBaseDir, loopId);

    // Ensure base directory exists
    if (!existsSync(this.config.worktreeBaseDir)) {
      mkdirSync(this.config.worktreeBaseDir, { recursive: true });
    }

    // Create worktree with new branch
    await execAsync(
      `git worktree add -b "${branchName}" "${worktreePath}" ${this.config.baseBranch}`,
      { cwd: this.config.repoDir }
    );

    return { worktreePath, branchName };
  }

  async merge(loopId: string): Promise<MergeResult> {
    const branchName = `c2/${this.config.runId}/${loopId}`;
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
    await execAsync(`git checkout ${this.config.baseBranch}`, { cwd: this.config.repoDir });

    // Attempt merge
    try {
      await execAsync(`git merge --no-ff "${branchName}" -m "Merge ${loopId}"`, {
        cwd: this.config.repoDir,
      });
      return { status: 'success' };
    } catch (e) {
      // Check for conflicts
      const { stdout } = await execAsync(`git diff --name-only --diff-filter=U`, {
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
}
