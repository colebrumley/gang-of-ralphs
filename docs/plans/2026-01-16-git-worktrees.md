# Git Worktrees Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Isolate parallel agent changes using git worktrees, enabling conflict-free parallel execution with automatic merge on task completion.

**Architecture:** Each agent loop gets its own git worktree in `.c2/worktrees/<loop-id>/`. Agents work on branches named `c2/<run-id>/<loop-id>`. On task completion, the loop's branch merges to the base branch (captured at startup). Conflicts trigger a dedicated resolution agent.

**Tech Stack:** Node.js, git CLI via child_process, TypeScript

---

## Task 1: WorktreeManager Core Class

**Files:**
- Create: `src/worktrees/manager.ts`
- Create: `src/worktrees/manager.test.ts`

### Step 1.1: Write failing test for WorktreeManager.create()

```typescript
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
});
```

### Step 1.2: Run test to verify it fails

Run: `npx tsx --test src/worktrees/manager.test.ts`
Expected: FAIL with "Cannot find module './manager.js'"

### Step 1.3: Write minimal WorktreeManager implementation

```typescript
// src/worktrees/manager.ts
import { execSync, exec } from 'node:child_process';
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
}
```

### Step 1.4: Run test to verify it passes

Run: `npx tsx --test src/worktrees/manager.test.ts`
Expected: PASS

### Step 1.5: Commit

```bash
git add src/worktrees/manager.ts src/worktrees/manager.test.ts
git commit -m "feat(worktrees): add WorktreeManager.create()"
```

---

## Task 2: WorktreeManager Merge Logic

**Files:**
- Modify: `src/worktrees/manager.ts`
- Modify: `src/worktrees/manager.test.ts`

### Step 2.1: Write failing test for merge()

Add to `src/worktrees/manager.test.ts`:

```typescript
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
```

### Step 2.2: Run test to verify it fails

Run: `npx tsx --test src/worktrees/manager.test.ts`
Expected: FAIL with "worktreeManager.merge is not a function"

### Step 2.3: Implement merge()

Add to `src/worktrees/manager.ts` WorktreeManager class:

```typescript
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
```

### Step 2.4: Run test to verify it passes

Run: `npx tsx --test src/worktrees/manager.test.ts`
Expected: PASS

### Step 2.5: Commit

```bash
git add src/worktrees/manager.ts src/worktrees/manager.test.ts
git commit -m "feat(worktrees): add WorktreeManager.merge()"
```

---

## Task 3: WorktreeManager Cleanup

**Files:**
- Modify: `src/worktrees/manager.ts`
- Modify: `src/worktrees/manager.test.ts`

### Step 3.1: Write failing test for cleanup()

Add to `src/worktrees/manager.test.ts`:

```typescript
  describe('cleanup()', () => {
    it('removes worktree and branch', async () => {
      const { worktreePath, branchName } = await worktreeManager.create('loop-cleanup');

      // Verify worktree exists
      assert.ok(existsSync(worktreePath));

      // Cleanup
      await worktreeManager.cleanup('loop-cleanup');

      // Verify worktree removed
      assert.ok(!existsSync(worktreePath));

      // Verify branch removed
      const branches = execSync(`git branch --list "${branchName}"`, { cwd: repoDir, stdio: 'pipe' });
      assert.strictEqual(branches.toString().trim(), '');
    });
  });

  describe('cleanupAll()', () => {
    it('removes all worktrees for this run', async () => {
      await worktreeManager.create('loop-1');
      await worktreeManager.create('loop-2');

      await worktreeManager.cleanupAll();

      const worktreeDir = join(repoDir, '.c2', 'worktrees');
      assert.ok(!existsSync(worktreeDir) || readdirSync(worktreeDir).length === 0);
    });
  });
```

Add import at top:
```typescript
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
```

### Step 3.2: Run test to verify it fails

Run: `npx tsx --test src/worktrees/manager.test.ts`
Expected: FAIL with "worktreeManager.cleanup is not a function"

### Step 3.3: Implement cleanup() and cleanupAll()

Add to `src/worktrees/manager.ts` WorktreeManager class:

```typescript
  async cleanup(loopId: string): Promise<void> {
    const branchName = `c2/${this.config.runId}/${loopId}`;
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
    const { stdout } = await execAsync(`git worktree list --porcelain`, {
      cwd: this.config.repoDir,
    });

    const runPrefix = `c2/${this.config.runId}/`;
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
```

### Step 3.4: Run test to verify it passes

Run: `npx tsx --test src/worktrees/manager.test.ts`
Expected: PASS

### Step 3.5: Commit

```bash
git add src/worktrees/manager.ts src/worktrees/manager.test.ts
git commit -m "feat(worktrees): add WorktreeManager cleanup methods"
```

---

## Task 4: State Schema Changes

**Files:**
- Modify: `src/types/state.ts`
- Modify: `src/types/loop.ts`
- Modify: `src/state/index.ts`
- Modify: `src/db/schema.sql`

### Step 4.1: Add baseBranch to OrchestratorState

Edit `src/types/state.ts`, add to OrchestratorState interface after `stateDir`:

```typescript
  // Git worktree isolation
  baseBranch: string | null; // null if not a git repo
  useWorktrees: boolean;
```

### Step 4.2: Add worktreePath to LoopState

Edit `src/types/loop.ts`, add to LoopState interface after `output`:

```typescript
  worktreePath: string | null; // Path to git worktree (null if not using worktrees)
```

### Step 4.3: Update initializeState

Edit `src/state/index.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { EffortLevel, OrchestratorState } from '../types/index.js';
import { getEffortConfig } from '../config/effort.js';

export interface InitStateOptions {
  specPath: string;
  effort: EffortLevel;
  stateDir: string;
  maxLoops: number;
  maxIterations: number;
  useWorktrees?: boolean;
}

function getBaseBranch(): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' })
      .toString()
      .trim();
  } catch {
    return null; // Not a git repo
  }
}

function isGitClean(): boolean {
  try {
    execSync('git diff --quiet && git diff --cached --quiet', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function initializeState(options: InitStateOptions): OrchestratorState {
  const effortConfig = getEffortConfig(options.effort);
  const baseBranch = getBaseBranch();
  const useWorktrees = options.useWorktrees !== false && baseBranch !== null;

  if (useWorktrees && !isGitClean()) {
    throw new Error('Cannot run c2 with uncommitted changes - commit or stash first');
  }

  return {
    runId: randomUUID(),
    specPath: options.specPath,
    effort: options.effort,
    phase: 'enumerate',
    phaseHistory: [],
    tasks: [],
    taskGraph: null,
    activeLoops: [],
    completedTasks: [],
    pendingReview: false,
    reviewType: null,
    revisionCount: 0,
    context: {
      discoveries: [],
      errors: [],
      decisions: [],
    },
    costs: {
      totalCostUsd: 0,
      phaseCosts: {
        enumerate: 0,
        plan: 0,
        build: 0,
        review: 0,
        revise: 0,
        complete: 0,
      },
      loopCosts: {},
    },
    costLimits: effortConfig.costLimits,
    maxLoops: options.maxLoops,
    maxIterations: options.maxIterations,
    stateDir: options.stateDir,
    baseBranch,
    useWorktrees,
  };
}

export { OrchestratorStateSchema } from './schema.js';
```

### Step 4.4: Update database schema

Edit `src/db/schema.sql`, add to `runs` table (after `updated_at`):

```sql
  base_branch TEXT,
  use_worktrees INTEGER NOT NULL DEFAULT 1
```

Add to `loops` table (after `cost_usd`):

```sql
  worktree_path TEXT
```

### Step 4.5: Run tests

Run: `npm run test`
Expected: PASS (existing tests should still work)

### Step 4.6: Commit

```bash
git add src/types/state.ts src/types/loop.ts src/state/index.ts src/db/schema.sql
git commit -m "feat(worktrees): add baseBranch and worktreePath to state"
```

---

## Task 5: LoopManager Integration

**Files:**
- Modify: `src/loops/manager.ts`
- Modify: `src/loops/manager.test.ts`

### Step 5.1: Write failing test for worktree integration

Add new test file section to `src/loops/manager.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LoopManager } from './manager.js';
import { WorktreeManager } from '../worktrees/manager.js';

describe('LoopManager with worktrees', () => {
  let testDir: string;
  let repoDir: string;
  let loopManager: LoopManager;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'c2-loop-wt-test-'));
    repoDir = join(testDir, 'repo');
    execSync(`mkdir -p ${repoDir} && cd ${repoDir} && git init && git commit --allow-empty -m "init"`, { stdio: 'pipe' });

    worktreeManager = new WorktreeManager({
      repoDir,
      worktreeBaseDir: join(repoDir, '.c2', 'worktrees'),
      baseBranch: 'main',
      runId: 'test-run',
    });

    loopManager = new LoopManager({
      maxLoops: 4,
      maxIterations: 20,
      reviewInterval: 5,
    }, worktreeManager);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates worktree when creating loop', async () => {
    const loop = await loopManager.createLoop(['task-1'], [{ id: 'task-1', title: 'Test', description: '', dependencies: [], estimatedIterations: 10 }]);

    assert.ok(loop.worktreePath);
    assert.ok(loop.worktreePath.includes('loop-'));
  });
});
```

### Step 5.2: Run test to verify it fails

Run: `npx tsx --test src/loops/manager.test.ts`
Expected: FAIL

### Step 5.3: Update LoopManager to use WorktreeManager

Edit `src/loops/manager.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type { Task, LoopState } from '../types/index.js';
import type { WorktreeManager } from '../worktrees/manager.js';

export interface LoopManagerConfig {
  maxLoops: number;
  maxIterations: number;
  reviewInterval: number;
}

export class LoopManager {
  private loops: Map<string, LoopState> = new Map();
  private config: LoopManagerConfig;
  private worktreeManager: WorktreeManager | null;

  constructor(config: LoopManagerConfig, worktreeManager?: WorktreeManager) {
    this.config = config;
    this.worktreeManager = worktreeManager ?? null;
  }

  async createLoop(taskIds: string[], tasks: Task[]): Promise<LoopState> {
    const loopId = randomUUID();
    let worktreePath: string | null = null;

    // Create worktree if manager is configured
    if (this.worktreeManager) {
      const result = await this.worktreeManager.create(loopId);
      worktreePath = result.worktreePath;
    }

    const loop: LoopState = {
      loopId,
      taskIds,
      iteration: 0,
      maxIterations: this.config.maxIterations,
      reviewInterval: this.config.reviewInterval,
      lastReviewAt: 0,
      status: 'pending',
      stuckIndicators: {
        sameErrorCount: 0,
        noProgressCount: 0,
        lastError: null,
        lastFileChangeIteration: 0,
      },
      output: [],
      worktreePath,
    };

    this.loops.set(loopId, loop);

    // Update task assignments
    for (const task of tasks) {
      if (taskIds.includes(task.id)) {
        task.assignedLoopId = loopId;
      }
    }

    return loop;
  }

  // ... rest of methods unchanged, but make createLoop the only async one
```

Note: `createLoop` is now async. Update all call sites.

### Step 5.4: Run test to verify it passes

Run: `npx tsx --test src/loops/manager.test.ts`
Expected: PASS

### Step 5.5: Commit

```bash
git add src/loops/manager.ts src/loops/manager.test.ts
git commit -m "feat(worktrees): integrate WorktreeManager into LoopManager"
```

---

## Task 6: Build Phase Merge Integration

**Files:**
- Modify: `src/orchestrator/phases/build.ts`
- Create: `src/orchestrator/phases/conflict.ts`
- Modify: `src/agents/prompts.ts`
- Modify: `src/agents/spawn.ts`

### Step 6.1: Add conflict phase to types

Edit `src/types/state.ts`, update Phase type:

```typescript
export type Phase = 'enumerate' | 'plan' | 'build' | 'review' | 'revise' | 'conflict' | 'complete';
```

### Step 6.2: Add CONFLICT_PROMPT

Edit `src/agents/prompts.ts`, add:

```typescript
export const CONFLICT_PROMPT = `You are resolving a git merge conflict.

The following files have conflicts that need to be resolved:
{{conflictFiles}}

The original task was:
{{taskDescription}}

Instructions:
1. Read each conflicting file to understand both sides of the conflict
2. The conflict markers look like:
   <<<<<<< HEAD
   (code from base branch)
   =======
   (code from your branch)
   >>>>>>> branch-name
3. Edit each file to resolve the conflict by keeping the correct code
4. Remove all conflict markers
5. Run \`git add <file>\` for each resolved file
6. Run \`git commit -m "resolve merge conflicts"\` to complete

When done, output: CONFLICT_RESOLVED
If you cannot resolve, output: CONFLICT_FAILED: <reason>`;
```

### Step 6.3: Add conflict phase tools

Edit `src/agents/spawn.ts`, add to PHASE_TOOLS:

```typescript
const PHASE_TOOLS: Record<Phase, string[]> = {
  enumerate: ['Read', 'Glob', 'Grep'],
  plan: ['Read', 'Glob', 'Grep'],
  build: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  review: ['Read', 'Glob', 'Grep', 'Bash'],
  revise: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  conflict: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  complete: [],
};

const PHASE_MAX_TURNS: Record<Phase, number> = {
  enumerate: 50,
  plan: 30,
  build: 100,
  review: 50,
  revise: 100,
  conflict: 15,
  complete: 1,
};
```

### Step 6.4: Create conflict resolution phase

Create `src/orchestrator/phases/conflict.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Task } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { CONFLICT_PROMPT } from '../../agents/prompts.js';

export interface ConflictResult {
  resolved: boolean;
  error?: string;
}

export async function resolveConflict(
  task: Task,
  conflictFiles: string[],
  repoDir: string,
  onOutput?: (text: string) => void
): Promise<ConflictResult> {
  const config = createAgentConfig('conflict', repoDir);

  const prompt = CONFLICT_PROMPT
    .replace('{{conflictFiles}}', conflictFiles.map(f => `- ${f}`).join('\n'))
    .replace('{{taskDescription}}', `${task.title}: ${task.description}`);

  let output = '';

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
      },
    })) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block) {
            output += block.text;
            onOutput?.(block.text);
          }
        }
      }
    }

    if (output.includes('CONFLICT_RESOLVED')) {
      return { resolved: true };
    }

    const failMatch = output.match(/CONFLICT_FAILED:\s*(.+)/);
    return {
      resolved: false,
      error: failMatch?.[1] || 'Unknown conflict resolution failure',
    };
  } catch (e) {
    return { resolved: false, error: String(e) };
  }
}
```

### Step 6.5: Update build.ts to handle merges

Edit `src/orchestrator/phases/build.ts`, update the loop completion logic:

```typescript
// After line 116 (if (output.includes('TASK_COMPLETE')))
// Replace the completion block:

      if (output.includes('TASK_COMPLETE')) {
        // Merge worktree if using worktrees
        if (loop.worktreePath && worktreeManager) {
          const mergeResult = await worktreeManager.merge(loop.loopId);

          if (mergeResult.status === 'conflict') {
            // Spawn conflict resolution agent
            const conflictResult = await resolveConflict(
              task,
              mergeResult.conflictFiles,
              config.cwd,
              (text) => onLoopOutput?.(loop.loopId, text)
            );

            if (!conflictResult.resolved) {
              loopManager.updateLoopStatus(loop.loopId, 'failed');
              return { loopId: loop.loopId, taskId: task.id, completed: false };
            }
          }

          // Cleanup worktree on successful merge
          await worktreeManager.cleanup(loop.loopId);
        }

        loopManager.updateLoopStatus(loop.loopId, 'completed');
        return { loopId: loop.loopId, taskId: task.id, completed: true };
      }
```

Add import at top:
```typescript
import { resolveConflict } from './conflict.js';
import type { WorktreeManager } from '../../worktrees/manager.js';
```

Update function signature:
```typescript
export async function executeBuildIteration(
  state: OrchestratorState,
  loopManager: LoopManager,
  worktreeManager: WorktreeManager | null,
  onLoopOutput?: (loopId: string, text: string) => void
): Promise<BuildResult>
```

### Step 6.6: Run tests

Run: `npm run test`
Expected: PASS

### Step 6.7: Commit

```bash
git add src/orchestrator/phases/build.ts src/orchestrator/phases/conflict.ts src/agents/prompts.ts src/agents/spawn.ts src/types/state.ts
git commit -m "feat(worktrees): add merge and conflict resolution to build phase"
```

---

## Task 7: CLI Flags

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/index.ts`

### Step 7.1: Add --no-worktrees flag

Edit `src/cli.ts`, add option to both places:

```typescript
    .option('--no-worktrees', 'Disable git worktree isolation', false)
```

Add to CLIOptions interface:
```typescript
  noWorktrees: boolean;
```

Add to parseArgs return:
```typescript
    noWorktrees: opts.noWorktrees,
```

### Step 7.2: Update index.ts to pass useWorktrees

Edit `src/index.ts`:

```typescript
  let state = initializeState({
    specPath,
    effort: opts.effort,
    stateDir,
    maxLoops: parseInt(opts.maxLoops, 10),
    maxIterations: parseInt(opts.maxIterations, 10),
    useWorktrees: !opts.noWorktrees,
  });
```

### Step 7.3: Commit

```bash
git add src/cli.ts src/index.ts
git commit -m "feat(worktrees): add --no-worktrees CLI flag"
```

---

## Task 8: Clean Command

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/index.ts`

### Step 8.1: Add clean subcommand

Edit `src/cli.ts`, after the main program options add:

```typescript
export function createCleanCLI(): Command {
  const program = new Command();

  program
    .name('c2 clean')
    .description('Clean up stale worktrees')
    .option('--run <id>', 'Clean worktrees for specific run')
    .option('--all', 'Clean all c2 worktrees', false);

  return program;
}
```

### Step 8.2: Handle clean command in index.ts

Edit `src/index.ts`, add before main():

```typescript
async function cleanWorktrees(runId?: string) {
  const { execSync } = await import('node:child_process');
  const { rmSync, existsSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  const worktreeDir = join(process.cwd(), '.c2', 'worktrees');

  if (!existsSync(worktreeDir)) {
    console.log('No worktrees to clean');
    return;
  }

  const dirs = readdirSync(worktreeDir);

  for (const dir of dirs) {
    if (runId && !dir.includes(runId)) continue;

    const worktreePath = join(worktreeDir, dir);
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
      console.log(`Removed worktree: ${dir}`);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
      console.log(`Force removed: ${dir}`);
    }
  }

  // Prune worktree list
  execSync('git worktree prune', { stdio: 'pipe' });
  console.log('Worktree cleanup complete');
}
```

Update main() to handle clean:

```typescript
async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'clean') {
    const runId = args.includes('--run') ? args[args.indexOf('--run') + 1] : undefined;
    await cleanWorktrees(runId);
    return;
  }

  // ... rest of existing main()
}
```

### Step 8.3: Commit

```bash
git add src/cli.ts src/index.ts
git commit -m "feat(worktrees): add c2 clean command"
```

---

## Task 9: TUI Updates

**Files:**
- Modify: `src/tui/App.tsx` (or relevant TUI component)

### Step 9.1: Display worktree path in loop status

Find the TUI component that displays loop status and add worktree path display:

```typescript
// In loop status display component
{loop.worktreePath && (
  <Text dimColor>Worktree: {loop.worktreePath.split('/').slice(-2).join('/')}</Text>
)}
```

### Step 9.2: Test TUI manually

Run: `./bin/c2 --spec examples/c2-dry-run-spec.md --tui --dry-run`
Expected: TUI launches, no errors

### Step 9.3: Commit

```bash
git add src/tui/
git commit -m "feat(worktrees): show worktree path in TUI"
```

---

## Task 10: Integration Test

**Files:**
- Create: `src/worktrees/integration.test.ts`

### Step 10.1: Write end-to-end worktree test

```typescript
// src/worktrees/integration.test.ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorktreeManager } from './manager.js';

describe('Worktree Integration', () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'c2-integration-'));
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
      worktreeBaseDir: join(repoDir, '.c2', 'worktrees'),
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
});
```

### Step 10.2: Run integration test

Run: `npx tsx --test src/worktrees/integration.test.ts`
Expected: PASS

### Step 10.3: Commit

```bash
git add src/worktrees/integration.test.ts
git commit -m "test(worktrees): add integration test for full lifecycle"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | WorktreeManager.create() | `src/worktrees/manager.ts` |
| 2 | WorktreeManager.merge() | `src/worktrees/manager.ts` |
| 3 | WorktreeManager cleanup | `src/worktrees/manager.ts` |
| 4 | State schema changes | `src/types/`, `src/state/`, `src/db/` |
| 5 | LoopManager integration | `src/loops/manager.ts` |
| 6 | Build phase merge + conflict | `src/orchestrator/phases/` |
| 7 | CLI --no-worktrees flag | `src/cli.ts`, `src/index.ts` |
| 8 | c2 clean command | `src/cli.ts`, `src/index.ts` |
| 9 | TUI worktree display | `src/tui/` |
| 10 | Integration test | `src/worktrees/integration.test.ts` |
