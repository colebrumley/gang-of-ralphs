# Git Worktrees for Agent Isolation

**Date**: 2026-01-16
**Status**: Proposed

## Problem

Currently, all parallel agents in C2 share the same working directory (`process.cwd()`). This causes:

1. **File conflicts** - Agents editing the same file simultaneously can cause corruption
2. **No rollback** - If one agent's work fails review, its changes are already mixed with others
3. **Messy git history** - All agent changes interleaved, hard to attribute or revert

## Solution

Use git worktrees to give each agent loop its own isolated working directory. Each agent works on a separate branch, which merges back to the base branch when its task completes.

## Design

### Worktree Lifecycle

**Creation**: When the BUILD phase starts a new loop, the LoopManager creates a git worktree:

```
.c2/
├── c2.db                    # SQLite state (shared)
└── worktrees/
    ├── loop-abc123/         # Worktree for loop abc123
    │   ├── .git             # Git worktree link
    │   └── <full repo>      # Complete working copy
    └── loop-def456/         # Worktree for loop def456
```

**Branch naming**: Each worktree gets a branch like `c2/<run-id>/<loop-id>` (e.g., `c2/run-7f3a/loop-abc123`).

**Agent execution**: The agent's `cwd` is set to the worktree path instead of `process.cwd()`.

**Merge on completion**: When an agent calls `complete_task()`:
1. Commit any uncommitted changes in the worktree
2. Switch to the base branch (original branch when c2 started)
3. Merge the loop's branch
4. If conflicts occur, spawn a conflict-resolution agent
5. Delete the worktree and branch on success

**Cleanup on failure**: If a task fails or gets stuck, the worktree remains for debugging.

### Code Changes

**New module** `src/worktrees/manager.ts`:

```typescript
export class WorktreeManager {
  constructor(
    private baseDir: string,      // .c2/worktrees
    private baseBranch: string,   // Branch when c2 started
    private runId: string
  ) {}

  async create(loopId: string): Promise<string>   // Returns worktree path
  async merge(loopId: string): Promise<MergeResult>
  async cleanup(loopId: string): Promise<void>
  async cleanupAll(): Promise<void>               // For c2 clean command
}

type MergeResult =
  | { status: 'success' }
  | { status: 'conflict'; conflictFiles: string[] }
```

**State changes**:
- Add `baseBranch: string` to `OrchestratorState`
- Add `worktreePath: string` to `LoopState`

**LoopManager integration**: Modify `createLoop()` to:
1. Call `worktreeManager.create(loopId)`
2. Store the worktree path in `LoopState`
3. Pass the worktree path as `cwd` to `createAgentConfig()`

**Build phase changes**: When a loop completes successfully:
1. Call `worktreeManager.merge(loopId)`
2. If conflict, spawn conflict-resolution agent
3. On merge success, call `worktreeManager.cleanup(loopId)`

**Database schema**: Add `worktree_path TEXT` column to `loops` table.

### Conflict Resolution

When `worktreeManager.merge()` returns a conflict:

1. Merge attempt fails, git leaves conflict markers in files
2. Orchestrator spawns agent with:
   - The original task description
   - List of conflicting files
   - Instructions to resolve conflicts and commit
3. Agent reads conflicting files, edits to resolve, runs `git add` and `git commit`
4. If agent fails to resolve, task is marked as failed (worktree preserved)

**Tool permissions for conflict phase**:
```typescript
conflict: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']
```

**Iteration limit**: `maxTurns: 15`

### Edge Cases

**Dirty working directory at startup**:
- Check if base branch has uncommitted changes
- Abort with error: "Cannot run c2 with uncommitted changes - commit or stash first"

**Worktree creation failure**:
- Mark the loop as failed
- Log error to context
- Other loops continue unaffected

**Orphaned worktrees** (from crashes):
- On startup, scan `.c2/worktrees/` for existing worktrees
- With `--resume`: reuse them
- Without `--resume`: warn user, suggest `c2 clean`

**Non-git repositories**:
- Skip worktree isolation entirely
- Fall back to shared working directory
- Log warning

### CLI

```bash
# Worktree isolation is ON by default (when in a git repo)
./bin/c2 --spec <path> --effort medium

# Opt-out flag
./bin/c2 --spec <path> --no-worktrees

# Cleanup command
./bin/c2 clean                    # Remove all .c2/worktrees/*
./bin/c2 clean --run <run-id>     # Remove worktrees from specific run
```

### TUI Updates

Show worktree status per loop:
```
┌─ Loop abc123 ─────────────────────┐
│ Task: Add user authentication     │
│ Worktree: .c2/worktrees/loop-abc  │
│ Status: running (iteration 3/20)  │
└───────────────────────────────────┘
```

### Testing

1. **Unit tests** for `WorktreeManager` - mock git commands
2. **Integration tests** - real worktrees in temp git repo
3. **Conflict resolution test** - intentional conflicts, verify agent resolves

## Implementation Order

1. `WorktreeManager` class with create/merge/cleanup
2. State schema changes (`baseBranch`, `worktreePath`)
3. LoopManager integration
4. Build phase merge logic
5. Conflict resolution agent
6. CLI flags (`--no-worktrees`)
7. `c2 clean` command
8. TUI updates
9. Tests
