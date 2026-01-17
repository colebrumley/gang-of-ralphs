# Claude Squad

An AI orchestration system that coordinates multiple Claude Code agents to implement software from specifications. Give it a spec file, and it breaks the work into tasks, plans execution order, spawns parallel agents in isolated git worktrees, and merges the results.

## Why Claude Squad?

- **Parallel execution** - Multiple agents work simultaneously on independent tasks
- **Git isolation** - Each agent works in its own worktree, preventing conflicts
- **Automatic conflict resolution** - When merges conflict, a dedicated agent resolves them
- **Quality control** - Built-in review phases validate work against the original spec
- **Stateless orchestration** - Resume interrupted runs; state persists to SQLite

## Quick Start

```bash
# Clone and build
git clone https://github.com/colebrumley/claude-squad.git
cd claude-squad
npm install && npm run build
npm link  # Creates global 'sq' command

# Run on a spec file
sq --spec feature.md --effort medium --tui
```

## Installation

```bash
git clone https://github.com/colebrumley/claude-squad.git
cd claude-squad
npm install
npm run build
npm link  # Creates global 'sq' command
```

### Prerequisites

- Node.js 20+
- Git (for worktree isolation)
- Claude Code CLI configured with API access

## Usage

```bash
sq --spec <path> [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--spec <path>` | Path to spec file (required) | - |
| `--effort <level>` | Quality level: `low`, `medium`, `high`, `max` | `medium` |
| `--tui` | Show terminal UI with live progress | off |
| `--dry-run` | Preview tasks and plan without executing | off |
| `--no-worktrees` | Disable git worktree isolation | off |
| `--resume` | Resume an interrupted run | off |
| `--reset` | Discard state and start fresh | off |
| `--max-loops <n>` | Max concurrent parallel agents | 4 |
| `--max-iterations <n>` | Max iterations per agent loop | 20 |
| `--state-dir <path>` | State directory | `.sq` |

### Examples

```bash
# Preview what would happen
sq --spec feature.md --dry-run

# Run with live UI
sq --spec feature.md --effort high --tui

# Simple single-agent run (no worktrees)
sq --spec bugfix.md --no-worktrees

# Resume after interruption
sq --spec feature.md --resume
```

## Effort Levels

The `--effort` flag controls how thoroughly sq reviews work:

| Level | When to Use | Review Behavior |
|-------|-------------|-----------------|
| `low` | Fast iteration, trusted specs | Reviews only at the end |
| `medium` | Default, balanced approach | Reviews after planning |
| `high` | Critical features, complex specs | Reviews after each major phase |
| `max` | Production code, full validation | Reviews every iteration |

Higher effort means more thorough validation but longer execution time.

## Writing Specs

Specs are markdown files describing what to build. See [docs/writing-specs.md](docs/writing-specs.md) for the full guide.

Good specs include:
- **Clear requirements** - Numbered list of discrete features
- **File locations** - Where code should go (e.g., "Create `src/auth/login.ts`")
- **Dependencies** - What existing code to integrate with
- **Test expectations** - What tests should verify

Minimal example:

```markdown
# Greeting Module

Create a greeting utility.

## Requirements

1. Create `src/greet.ts` with a `greet(name: string)` function
2. Return "Hello, {name}!" for valid names
3. Return "Hello, World!" for empty string
4. Add tests in `src/greet.test.ts`
```

See `examples/` for more sample specs.

## TUI Mode

Run with `--tui` for a terminal interface showing:

- Overall progress and current phase
- Active agent loops with their tasks
- Streaming output from each agent

## How It Works

sq operates as a state machine with these phases:

1. **Enumerate** - Reads your spec and breaks it into discrete tasks
2. **Plan** - Analyzes dependencies and groups tasks for parallel execution
3. **Build** - Spawns Claude Code agents to implement each task
4. **Conflict** - Resolves any merge conflicts between parallel agents
5. **Review** - Validates completed work (depth depends on effort level)
6. **Revise** - Re-enters BUILD if review finds issues

The orchestrator is stateless per invocation - it loads state, executes one phase step, saves state, and exits. An outer loop continuously restarts it until completion.

## Git Worktree Isolation

By default, parallel agents work in isolated git worktrees to prevent conflicts. Each agent gets its own branch (`sq/<runId>/<loopId>`) and directory.

When agents complete, their changes merge back to the base branch. If conflicts occur, sq spawns a dedicated agent to resolve them.

Disable with `--no-worktrees` for simpler single-agent runs or when git isolation isn't needed.

## State and Resume

sq saves state to `.sq/` between invocations. This enables:

- **Resume** - Continue where you left off after interruption
- **Inspection** - View tasks, progress, and agent outputs
- **Debugging** - Understand what happened when something fails

Use `--reset` to discard state and start fresh.

## Cleanup

```bash
sq clean --all              # Remove all sq worktrees and branches
sq clean --run <id>         # Remove worktrees for a specific run
```

## License

MIT
