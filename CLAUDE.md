# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Squad is an AI orchestration system that coordinates multiple Claude Code agents to implement software from specifications. It breaks specs into tasks, plans execution order, spawns parallel agents in isolated git worktrees, and manages state across invocations.

**Key design**: The orchestrator is stateless per invocation. It loads state from disk, executes one phase, saves state, and exits. An outer bash loop continuously restarts it until completion.

## Prerequisites

- Node.js 20+
- Git (for worktree isolation features)
- Claude Code CLI configured with API access

## Development Commands

```bash
npm install           # Install dependencies
npm run build         # Compile TypeScript to dist/
npm run dev           # Run directly with tsx (no compile needed)
npm run test          # Run all tests
npm run lint          # Run biome linter
npm run typecheck     # Type check without emitting
```

## Running the CLI

```bash
# Basic usage (TUI enabled by default)
./bin/sq --spec <path> --effort medium

# Common options
./bin/sq --spec <path> --dry-run           # Preview tasks and plan without executing
./bin/sq --spec <path> --no-tui            # Disable TUI interface
./bin/sq --spec <path> --no-worktrees      # Disable git worktree isolation
./bin/sq --spec <path> --resume            # Resume interrupted run
./bin/sq --spec <path> --reset             # Discard state, start fresh
./bin/sq --spec <path> --debug             # Enable debug tracing to .sq/debug/<runId>/
./bin/sq --spec <path> --max-loops <n>     # Max concurrent parallel loops (default: 4)
./bin/sq --spec <path> --max-iterations <n> # Max iterations per loop (default: 50)
./bin/sq --spec <path> --state-dir <path>  # Custom state directory (default: .sq)

# Cleanup
./bin/sq clean --all                       # Clean all sq worktrees
./bin/sq clean --run <id>                  # Clean worktrees for specific run
```

## Architecture

### Phase State Machine

```
ANALYZE → [Review?] → ENUMERATE → [Review?] → PLAN → [Review?] → BUILD → [CONFLICT?] → [Review?] → [REVISE] → COMPLETE
    ↓                      ↓                     ↓           ↓            ↓              ↓           ↓
 review?               review?               review?    per-loop      merge          interval    review
 (max only)            (effort)              (effort)   reviews     conflict        review      failed
                                                        on task                     (effort)
                                                        complete
```

**Phase descriptions**:

- **ANALYZE**: First phase that explores the existing codebase before task creation. Agent uses READ-ONLY tools (Read, Glob, Grep) to understand project type, tech stack, directory structure, existing features, entry points, and coding patterns. Calls `set_codebase_analysis()` MCP tool to store results. For empty projects, skips agent and stores minimal analysis. Results are injected into ENUMERATE prompt.

- **ENUMERATE**: Agent reads spec with READ-ONLY tools (Read, Glob, Grep), calls `write_task()` MCP tool for each discrete task. Receives codebase analysis from ANALYZE phase to avoid creating tasks for existing features. Includes scaffold instructions only for new codebases.

- **PLAN**: Agent receives task list as JSON, analyzes dependencies, calls `add_plan_group(groupIndex, taskIds)` to create parallel execution groups. Group 0 runs first, then group 1, etc. Tasks in the same group run concurrently.

- **BUILD**: LoopManager spawns parallel agents in isolated git worktrees with full tools (Read, Edit, Write, Bash, Glob, Grep). Uses **Ralph Wiggum patterns** for atomic updates: each iteration makes ONE small change (one file, one function) followed by verification, then outputs ITERATION_DONE to continue the loop. TASK_COMPLETE only when all criteria are met with fresh test evidence. Per-loop review system runs immediate review after TASK_COMPLETE signal. Injects review feedback via `buildPromptWithFeedback()` on next iteration. Monitors idle timeout (5 minutes), repeated errors, no file changes, and max iterations for stuck detection.

- **CONFLICT**: Triggered when worktree merge fails. Spawns agent with conflict files list and task description to resolve using Read, Edit, Write, Bash tools. Returns resolved boolean and error message.

- **REVIEW**: Validates work quality at different checkpoints (enumerate, plan, build). Reviews check if implementation serves interpreted intent, not just literal spec. Agent calls `set_review_result(interpretedIntent, intentSatisfied, passed, issues)`. Requires evidence (test runs, file reads) before passing. Reviews pass ONLY if both `passed` AND `intentSatisfied` are true.

- **REVISE**: Analyzes review failures and creates fix plan with priority actions. Stores analysis in context for next BUILD iteration. Max revisions limit prevents infinite loops (varies by effort level).

### Per-Loop Reviews

Each loop gets immediate review after task completion:
- Uses `set_loop_review_result(loopId, taskId, passed, issues)`
- Stores results in `loop_reviews` table with revision tracking
- Failed reviews increment `revisionAttempts` counter
- Exceeding `maxRevisionAttempts` marks loop as stuck
- Review issues injected as feedback in next iteration

### Data Flow

Agents communicate via MCP tools instead of outputting JSON. This eliminates parsing errors:

**Task Management**:
- `write_task(id, title, description, dependencies, estimatedIterations)` - Create task
- `complete_task(taskId)` - Mark task complete
- `fail_task(taskId, reason)` - Mark task failed

**Planning**:
- `add_plan_group(groupIndex, taskIds)` - Define parallel execution group

**Loop Management**:
- `create_loop(taskIds, maxIterations, reviewInterval, worktreePath, phase)` - Create execution loop
- `persist_loop_state(loopId, iteration, ...)` - Save loop progress
- `update_loop_status(loopId, status, error)` - Update loop status

**Review & Feedback**:
- `set_review_result(interpretedIntent, intentSatisfied, passed, issues)` - Record run-level review
- `set_loop_review_result(loopId, taskId, passed, interpretedIntent, intentSatisfied, issues)` - Record loop review

**Cost Tracking**:
- `record_cost(costUsd, loopId, phase)` - Track API costs per loop
- `record_phase_cost(phase, costUsd)` - Record phase costs

**Context**:
- `add_context(type, content)` - Log discoveries, errors, decisions (type: 'discovery' | 'error' | 'decision')

**Codebase Analysis**:
- `set_codebase_analysis(projectType, techStack, directoryStructure, existingFeatures, entryPoints, patterns, summary)` - Store analysis from ANALYZE phase

### Git Worktree Isolation

By default, each parallel agent loop runs in an isolated git worktree to prevent conflicts:

1. **Create**: `WorktreeManager.create(loopId)` creates branch `sq/<runId>/<loopId>` and worktree at `.sq/worktrees/<loopId>`
2. **Work**: Agent works in isolation, committing changes to its branch
3. **Merge**: Auto-commits before merge with `git commit -m "auto-commit before merge"`, then `git merge --no-ff` for traceable history
4. **Conflict**: Detects conflicts via `git diff --name-only --diff-filter=U`, spawns CONFLICT phase agent to resolve
5. **Cleanup**: `git worktree remove --force` and `git branch -D` removes worktree and branch

Disable with `--no-worktrees` for simpler single-agent runs.

### Key Directories

- `src/orchestrator/` - Core state machine and phase implementations
- `src/orchestrator/phases/` - Individual phase logic (analyze, enumerate, plan, build, review, conflict, revise)
- `src/agents/` - Agent spawning configs and system prompts
- `src/loops/` - LoopManager for parallel execution, stuck detection, idle timeout
- `src/worktrees/` - Git worktree management for parallel isolation
- `src/mcp/` - MCP server with tool definitions for agent-to-DB communication
- `src/db/` - SQLite schema and helpers
- `src/state/` - State initialization and Zod schema validation
- `src/tui/` - Ink/React terminal UI components
- `src/config/effort.ts` - Effort level configurations
- `src/costs/` - Three-tier cost tracking (per-loop, per-phase, per-run)

### Effort Levels

The `--effort` flag controls orchestrator behavior:

| Setting | low | medium | high | max |
|---------|-----|--------|------|-----|
| **Review after analyze** | ✗ | ✗ | ✗ | ✓ |
| **Review after enumerate** | ✗ | ✗ | ✓ | ✓ |
| **Review after plan** | ✗ | ✓ | ✓ | ✓ |
| **Review interval** (iterations) | 10 | 5 | 3 | 1 |
| **Review depth** | shallow | standard | deep | comprehensive |
| **Stuck threshold** (errors) | 5 | 4 | 3 | 2 |
| **Max revisions** (BUILD→REVIEW→REVISE) | 10 | 8 | 5 | 3 |
| **Max revision attempts** (per-loop) | 2 | 3 | 4 | 5 |
| **Per-loop max cost** | $1 | $2 | $5 | $10 |
| **Per-phase max cost** | $2 | $5 | $10 | $25 |
| **Per-run max cost** | $5 | $15 | $30 | $100 |

**Model tiers by phase** (low/medium/high/max):

| Phase | low | medium | high | max |
|-------|-----|--------|------|-----|
| analyze | haiku | sonnet | sonnet | opus |
| enumerate | haiku | sonnet | sonnet | opus |
| plan | haiku | sonnet | opus | opus |
| build | opus | opus | opus | opus |
| review | haiku | sonnet | opus | opus |
| revise | haiku | sonnet | sonnet | opus |
| conflict | sonnet | sonnet | opus | opus |

Model IDs: haiku=`claude-haiku-4-20250514`, sonnet=`claude-sonnet-4-5-20250929`, opus=`claude-opus-4-20250514`

### State Persistence

State is persisted to SQLite (`.sq/state.db`) with tables for:

- `runs` - Run metadata, phase, effort level, cost tracking, interpreted_intent, intent_satisfied
- `tasks` - Individual tasks with status, dependencies (JSON), estimated_iterations, assigned_loop_id
- `loops` - Agent loops with iteration counts, status, same_error_count, no_progress_count, last_activity_at, cost_usd, worktree_path
- `plan_groups` - Task groupings for parallel execution with group_index and task_ids (JSON)
- `context_entries` - Discoveries, errors, and decisions logged during execution
- `review_issues` - Structured review feedback with file, line, type, description, suggestion, loop_id, loop_review_id
- `loop_reviews` - Per-loop review results with passed, interpreted_intent, intent_satisfied, reviewed_at, cost_usd
- `phase_history` - Completed phases log with success status and cost
- `phase_costs` - Accumulated costs per phase

### Stuck Detection

Loops are marked stuck when:
- **Repeated errors**: Same error ≥ stuckThreshold times
- **No progress**: No file changes in ≥ (stuckThreshold + 2) iterations
- **Max iterations**: iteration > maxIterations
- **Idle timeout**: No output for 5 minutes (checked every 30 seconds)
- **Max revision attempts**: Per-loop review failures exceed maxRevisionAttempts

### Cost Limits

Three-tier enforcement prevents runaway costs:
1. **Per-loop**: Single loop cannot exceed limit (prevents one agent from burning budget)
2. **Per-phase**: Total phase cost across all loops cannot exceed limit
3. **Per-run**: Hard cap on total orchestrator cost

When exceeded: adds error to context, marks loops failed, transitions to COMPLETE phase.

### Agent Spawning

Phase-specific tool allowlists (`src/agents/spawn.ts`):
- **Analyze/Enumerate/Plan**: Read, Glob, Grep only (read-only exploration)
- **Build**: Read, Edit, Write, Bash, Glob, Grep + all MCP tools
- **Review**: Read, Glob, Grep, Bash + all MCP tools (no editing)
- **Conflict**: Read, Edit, Write, Bash, Glob, Grep + MCP tools

Max turns per phase: analyze=30, enumerate=50, plan=30, build=100, review=50, revise=100, conflict=15

Permission mode: `bypassPermissions` (auto-accept all prompts for unattended execution)

### TUI Features

Enabled by default (disable with `--no-tui`), displays:
- Overall progress and current phase
- Active agent loops with assigned tasks
- Streaming output: thinking deltas, text deltas, tool activity
- Task status breakdown with symbols: ✓ completed, ○ pending, ● in progress, ✗ failed
- Real-time tool activity: `[tool] starting <toolname>`, `[tool] <toolname> (2.5s)`
- Buffered streaming prevents fragmented lines
- Adaptive column layout for narrow terminals

Keyboard shortcuts:
- `q` - Quit (saves state for resume)
- `p` - Pause/resume orchestration
- `r` - Trigger immediate review
- `1-4` - Focus on loop column (press again to unfocus)

## Testing

Tests use Node's built-in test runner with tsx:

```bash
npm run test                             # Run all tests
npx tsx --test src/loops/manager.test.ts # Run single test file
```

Test files are colocated with source files using `.test.ts` suffix.

## Type System

Core types in `src/types/`:
- `OrchestratorState` - Full state shape with phase tracking, tasks, loops, costs
- `Task` / `TaskGraph` - Task definitions with dependencies, estimated_iterations, parallel groups
- `LoopState` - Individual agent loop with iteration count, stuck indicators, last_activity_at
- `EffortLevel` / `Phase` - Union types for valid values

## Debug & Tracing

Enabled with `--debug` flag, writes to `.sq/debug/<runId>/`:
- `agent-calls.jsonl` - All agent invocations with prompts, outputs, costs
- `mcp-calls.jsonl` - All MCP tool calls with inputs, results, durations
- `trace.jsonl` - Phase starts/completes, loop events, decisions, errors, state snapshots

## Troubleshooting

### Tests fail with "database is locked"

Multiple test files may conflict when accessing SQLite. Run tests sequentially:
```bash
npx tsx --test src/path/to/specific.test.ts
```

### Stale worktrees cause git errors

Clean up orphaned worktrees and branches:
```bash
./bin/sq clean --all
git worktree prune
```

### State corruption after interrupted run

Reset state and start fresh:
```bash
./bin/sq --spec <path> --reset
```

Or manually remove state directory:
```bash
rm -rf .sq/
```

### MCP server connection issues

The MCP server runs on a Unix socket in the state directory. If connections fail:
1. Check `.sq/` exists and is writable
2. Ensure no zombie sq processes: `pkill -f "sq-mcp"`
3. Try `--reset` to reinitialize state

### Agents appear stuck but are actually idle

Check idle timeout logs. Agents with no output for 5 minutes are marked stuck with `IdleTimeoutError`.

### Review keeps failing

Check review issues in `.sq/state.db` table `review_issues` for specific problems. Per-loop reviews track revision attempts - exceeding `maxRevisionAttempts` marks loop as stuck.
