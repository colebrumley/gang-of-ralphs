# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Squad is an AI orchestration system that coordinates multiple Claude Code agents to implement software from specifications. It breaks specs into tasks, plans execution order, spawns parallel agents, and manages state across invocations.

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
npm run test:prompts  # Test prompt harness
npm run eval          # Run prompt evals
npm run lint          # Run biome linter
npm run typecheck     # Type check without emitting
```

## Running the CLI

```bash
# Basic usage
./bin/sq --spec <path> --effort medium --tui

# Common options
./bin/sq --spec <path> --dry-run       # Preview without executing
./bin/sq --spec <path> --no-worktrees  # Disable git worktree isolation
./bin/sq --spec <path> --resume        # Resume interrupted run
./bin/sq --spec <path> --reset         # Discard state, start fresh

# Cleanup
./bin/sq clean --all                   # Clean all sq worktrees
./bin/sq clean --run <id>              # Clean worktrees for specific run
```

## Architecture

### Phase State Machine

```
ENUMERATE → [Review?] → PLAN → [Review?] → BUILD → [CONFLICT?] → [Review?] → [REVISE] → COMPLETE
```

- **ENUMERATE**: Agent reads spec, calls MCP `write_task()` for each discrete task
- **PLAN**: Agent analyzes dependencies, groups tasks for parallel execution via `add_plan_group()`
- **BUILD**: LoopManager spawns parallel agents in isolated git worktrees
- **CONFLICT**: Resolves merge conflicts when worktree changes conflict
- **REVIEW**: Validates work quality (depth varies by effort level)
- **REVISE**: Returns to BUILD with error context when review fails

### Data Flow

Agents write to SQLite via MCP tools instead of outputting JSON. This eliminates parsing errors:
- `write_task()` / `complete_task()` / `fail_task()` - Task lifecycle
- `add_plan_group()` - Execution planning
- `update_loop_status()` - Loop state changes
- `add_context()` - Record discoveries/errors/decisions
- `set_review_result()` - Review outcomes

### Git Worktree Isolation

By default, each parallel agent loop runs in an isolated git worktree. This prevents conflicts during parallel development:

1. **Create**: `WorktreeManager.create(loopId)` creates branch `sq/<runId>/<loopId>` and worktree
2. **Work**: Agent works in isolation, committing changes to its branch
3. **Merge**: After completion, worktree changes merge back to base branch
4. **Conflict**: If merge fails, CONFLICT phase spawns agent to resolve
5. **Cleanup**: `sq clean` removes stale worktrees and branches

Disable with `--no-worktrees` for simpler single-agent runs.

### Key Directories

- `src/orchestrator/` - Core state machine and phase implementations
- `src/orchestrator/phases/` - Individual phase logic (enumerate, plan, build, review, conflict, revise)
- `src/agents/` - Agent spawning configs and system prompts
- `src/loops/` - LoopManager for parallel execution, stuck detection
- `src/worktrees/` - Git worktree management for parallel isolation
- `src/mcp/` - MCP server with tool definitions for agent-to-DB communication
- `src/db/` - SQLite schema and helpers
- `src/state/` - State initialization and Zod schema validation
- `src/tui/` - Ink/React terminal UI components
- `src/evals/` - Prompt evaluation system with A/B testing
- `src/config/effort.ts` - Effort level configurations

### Effort Levels

The `--effort` flag controls orchestrator behavior:

| Level | Review After | Review Interval | Depth | Stuck Threshold | Max Revisions |
|-------|--------------|-----------------|-------|-----------------|---------------|
| low | neither | 10 iterations | shallow | 5 errors | 10 |
| medium | plan | 5 iterations | standard | 4 errors | 8 |
| high | both | 3 iterations | deep | 3 errors | 5 |
| max | both | every iteration | comprehensive | 2 errors | 3 |

### State Persistence

State is persisted to SQLite (`.sq/state.db`) with tables for:
- `runs` - Run metadata, phase, effort level, cost tracking
- `tasks` - Individual tasks with status and loop assignment
- `loops` - Agent loops with iteration counts and status
- `plan_groups` - Task groupings for parallel execution
- `context_entries` - Discoveries, errors, and decisions

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
- `Task` / `TaskGraph` - Task definitions with dependencies and parallel groups
- `LoopState` - Individual agent loop with iteration count and stuck indicators
- `EffortLevel` / `Phase` - Union types for valid values

## Eval System

The eval system tests prompt quality with automated grading:

```bash
npm run eval                              # Run all test suites
npm run eval -- --case enumerate          # Run specific suite
npm run eval -- --compare promptA promptB # A/B compare prompts
npm run eval -- --baseline                # Save results as baseline
npm run eval -- --check                   # Check for regressions
```

Test cases live in `evals/cases/*.yaml`. Each defines inputs and expected behaviors that the grader scores.

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
