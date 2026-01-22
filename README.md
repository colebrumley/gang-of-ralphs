# Claude Squad

AI orchestration system that coordinates multiple Claude Code agents to implement software from specs. Breaks work into tasks, plans execution order, spawns parallel agents in isolated git worktrees, and merges results.

## Build Loop Methodology

Build loops use **Ralph Wiggum patterns** for reliable, incremental progress:

- **Atomic updates**: Each iteration makes ONE small change (create one file, add one function, fix one bug)
- **Continuous verification**: Every change is followed by tests/typecheck/build
- **Scratchpad memory**: Agents read/write progress to persist context across iterations
- **Default to ITERATION_DONE**: Agents continue looping until ALL criteria are met

This approach ensures small, debuggable changes with verification at each step, rather than monolithic implementations that are hard to debug when they fail.

## Development

```bash
npm install           # Install dependencies
npm run build         # Compile TypeScript to dist/
npm run dev           # Run directly with tsx
npm run test          # Run all tests
npm run lint          # Run biome linter
npm run typecheck     # Type check without emitting
```

**Prerequisites**: Node.js 20+, Git, Claude Code CLI with API access

## Usage

```bash
# Basic run (TUI enabled by default)
./bin/sq --spec feature.md --effort medium

# Preview without executing
./bin/sq --spec feature.md --dry-run

# Without terminal UI
./bin/sq --spec feature.md --no-tui

# Resume interrupted run
./bin/sq --spec feature.md --resume

# Debug tracing
./bin/sq --spec feature.md --debug

# Cleanup
./bin/sq clean --all
./bin/sq clean --run <id>
```

**Key flags**: `--effort low|medium|high|max`, `--no-tui`, `--no-worktrees`, `--reset`, `--max-loops <n>`, `--max-iterations <n>`

## Architecture

See [CLAUDE.md](CLAUDE.md) for detailed documentation.

**Phases**: ANALYZE → ENUMERATE → PLAN → BUILD → [CONFLICT] → [REVIEW] → [REVISE] → COMPLETE

**State**: SQLite in `.sq/state.db` - tasks, loops, reviews, costs

**Worktrees**: Each agent works in isolated git worktree (`sq/<runId>/<loopId>`)

## License

MIT
