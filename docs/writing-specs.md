# Writing Good Specs for Claude Squad

This guide explains how to write effective specification files that Claude Squad can break into tasks and implement efficiently.

## Table of Contents

- [Overview](#overview)
- [Spec Format](#spec-format)
- [What Makes a Good Spec](#what-makes-a-good-spec)
- [Example Specs](#example-specs)
- [Common Mistakes](#common-mistakes)
- [Effort Levels and Specs](#effort-levels-and-specs)
- [Quick Checklist](#quick-checklist)
- [Validating Your Spec](#validating-your-spec)

## Overview

Claude Squad accepts markdown spec files via `--spec <path>`. The spec is read by the ENUMERATE agent, which breaks it into discrete tasks. Better specs lead to better task breakdowns, more accurate parallel execution, and higher quality implementations.

## Spec Format

Specs are **plain markdown files**. No special syntax or frontmatter required—Claude interprets natural language.

### Minimal Spec (4-5 requirements)

```markdown
# Feature Name

One sentence describing what to build.

## Requirements

1. Create `src/feature.ts` with a `doThing()` function
2. Handle edge case X by doing Y
3. Return error when Z happens
4. Add tests in `src/feature.test.ts`
```

### Comprehensive Spec (10+ requirements)

```markdown
# Project or Feature Name

Brief description (1-3 sentences) of what to build and why.

## Background

Context explaining the problem domain. What exists today? What problem does this solve?

## Requirements

### Subsection 1 (e.g., "Core Logic")

1. Create `src/path/file.ts` with specific functions/classes
2. Implement specific behavior with clear success criteria
3. Handle error cases explicitly

### Subsection 2 (e.g., "UI Components")

4. Create `src/ui/component.ts` with described interface
5. Wire up to existing system at specific integration point

### Tests

6. Create `src/path/file.test.ts` testing specific behaviors
7. Add integration test for end-to-end flow

## Non-Goals

- What NOT to build (prevents scope creep)
- Features explicitly out of scope

## Example Usage

```bash
# How users will interact with the feature
command --flag value
```

## Technical Notes

Implementation guidance, constraints, or architectural decisions.
```

## What Makes a Good Spec

### 1. Specific File Paths

**Bad:** "Create a utility module"
**Good:** "Create `src/utils/parser.ts` with a `parseConfig()` function"

File paths help the agent know exactly where to put code and make task dependencies clearer.

### 2. Clear Success Criteria

**Bad:** "Handle errors appropriately"
**Good:** "Throw `InvalidConfigError` when the config file is missing or malformed"

Agents need to know what "done" looks like.

### 3. Right-Sized Requirements

Each numbered requirement should translate to roughly one task. The ENUMERATE agent will validate task size:

| Estimated Iterations | Guidance |
|---------------------|----------|
| < 3 | Too small—combine with related work |
| 3-25 | Good range |
| 5-20 | Optimal range |
| > 25 | Too large—break into subtasks |

One iteration ≈ one agent turn (code change + test cycle).

**Too small:**
```markdown
1. Create the file
2. Add the import statement
3. Write the function signature
```

**Right-sized:**
```markdown
1. Create `src/parser.ts` with a `parseConfig(path: string)` function that reads YAML files and returns typed configuration objects
```

**Too large:**
```markdown
1. Implement the entire authentication system with login, logout, session management, password reset, and OAuth integration
```

### 4. Explicit Dependencies

When requirements depend on each other, make it clear:

```markdown
1. Create `src/db/schema.ts` defining the User table
2. Create `src/db/queries.ts` with CRUD operations (requires: User table)
3. Create `src/api/users.ts` exposing REST endpoints (requires: queries)
```

The PLAN agent uses this to determine what can run in parallel vs sequentially.

### 5. Describe Behavior, Not Implementation

**Bad:** "Use a for loop to iterate through items"
**Good:** "Process all items in the queue, handling failures by logging and continuing"

Let the agent choose implementation details—focus on what the code should *do*.

### 6. Include Tests

Always include test requirements:

```markdown
### Tests

15. Create `src/parser.test.ts` with tests for:
    - Valid config files parse correctly
    - Missing files throw InvalidConfigError
    - Malformed YAML throws ParseError
```

Tests give agents feedback loops and define acceptance criteria.

### 7. Non-Goals Section

Explicitly state what's out of scope to prevent over-engineering:

```markdown
## Non-Goals

- Database migrations (manual for now)
- Admin UI (CLI only)
- i18n support (English only)
```

## Example Specs

### Simple Feature Spec

```markdown
# Greeting Module

Create a simple greeting utility for the CLI.

## Requirements

1. Create `src/greet.ts` with a `greet(name: string): string` function
2. Return "Hello, {name}!" for non-empty names
3. Return "Hello, World!" when name is empty
4. Add tests in `src/greet.test.ts` covering both cases
```

### Complex Feature Spec

```markdown
# Dry Run Mode

Add a `--dry-run` flag that previews orchestration without executing.

## Background

Users want to validate specs and estimate costs before running expensive agent operations. Dry-run mode should enumerate and plan, then report what would happen.

## Requirements

### CLI Changes

1. Add `--dry-run` boolean flag to `src/cli.ts`
2. Pass `dryRun: true` to orchestrator when flag is set
3. Display summary at end: task count, execution groups, estimated spawns

### Orchestrator Changes

4. Modify `src/orchestrator/index.ts` to accept `dryRun` option
5. In dry-run mode, stop after PLAN phase (skip BUILD)
6. Set final phase to COMPLETE with `dryRun: true` in state

### State Changes

7. Add `dryRun?: boolean` field to run state in `src/state/index.ts`
8. Update Zod schema to validate new field
9. Add state serialization test for dry-run flag

### Output

10. Create `src/orchestrator/summary.ts` with `printDryRunSummary(state)` function
11. Summary includes: task list, dependency graph, execution groups, estimated invocations

### Tests

12. Add CLI test for `--dry-run` flag parsing
13. Add orchestrator test verifying BUILD phase skip
14. Add summary output test with fixture data

## Non-Goals

- Cost estimation in dollars
- Interactive approval after dry-run
- Partial dry-run (some phases but not others)

## Example Usage

```bash
./bin/sq --spec feature.md --dry-run

# Output:
# === DRY RUN SUMMARY ===
# Tasks (5): [1] Create model...
# Execution Plan: Group 1: [1, 4], Group 2: [2, 3]...
```
```

### Full Application Spec

See `examples/minesweeper-spec.md` for a comprehensive example covering:
- Project setup (package.json, TypeScript config, build tooling)
- Multiple feature areas with numbered requirements
- Detailed behavior specifications
- Styling and accessibility requirements
- Test coverage requirements
- Non-goals section
- Example usage
- Technical implementation notes

## Common Mistakes

### 1. Vague Requirements

**Bad:**
```markdown
1. Improve the user experience
2. Make it faster
3. Fix bugs
```

**Good:**
```markdown
1. Add loading spinner in `src/ui/Loader.tsx` shown during API calls
2. Cache API responses in memory with 5-minute TTL in `src/cache.ts`
3. Fix null pointer in `src/parser.ts:45` when config.items is undefined
```

### 2. Implementation Over Behavior

**Bad:**
```markdown
1. Create a HashMap with string keys and User values
2. Use async/await for the database calls
3. Add a try-catch block around the parsing
```

**Good:**
```markdown
1. Store active users indexed by session ID for O(1) lookup
2. Database operations must be non-blocking
3. Parsing failures should throw descriptive errors, not crash
```

### 3. Missing Context

**Bad:**
```markdown
1. Add authentication
```

**Good:**
```markdown
1. Add JWT authentication to `src/api/middleware.ts`:
   - Validate tokens on all /api/* routes except /api/auth/*
   - Extract user ID from token and attach to request context
   - Return 401 for invalid/expired tokens
```

### 4. No Tests

**Bad:**
```markdown
1. Create parser module
2. Create API endpoint
3. Deploy to production
```

**Good:**
```markdown
1. Create parser module in `src/parser.ts`
2. Create API endpoint in `src/api/parse.ts`
3. Add unit tests in `src/parser.test.ts`
4. Add integration tests in `src/api/parse.test.ts`
```

## Effort Levels and Specs

The `--effort` flag affects how Claude Squad validates your spec:

| Effort | Review Depth | Spec Quality Needed |
|--------|-------------|---------------------|
| low | Shallow (tests pass?) | Basic requirements fine |
| medium | Standard (matches plan?) | Clear requirements recommended |
| high | Deep (matches spec?) | Detailed requirements important |
| max | Comprehensive (full spec check) | Thorough spec essential |

Higher effort levels check implementation against the spec more rigorously, so invest more time in spec quality when using `--effort high` or `--effort max`.

## Quick Checklist

Before running `sq --spec your-spec.md`:

- [ ] Each requirement has a specific file path
- [ ] Requirements are right-sized (3-25 iterations each)
- [ ] Success criteria are clear and testable
- [ ] Dependencies between requirements are evident
- [ ] Tests are included as requirements
- [ ] Non-goals prevent scope creep
- [ ] Technical constraints are documented

## Validating Your Spec

Use `--dry-run` to preview how Claude Squad interprets your spec:

```bash
./bin/sq --spec your-spec.md --effort medium --dry-run
```

This shows:
- Tasks that would be created
- Planned execution groups (parallelization)
- Estimated agent spawns

Review the task breakdown. If tasks seem wrong-sized or incorrectly grouped, revise your spec and try again.
