# Integration Tests Design

**Date**: 2026-01-19
**Status**: Approved

## Overview

Comprehensive integration tests for the orchestration system using mock agents. Tests verify holistic flows through the phase state machine without invoking real Claude Code agents.

## Goals

1. Test end-to-end orchestration flows (ANALYZE → COMPLETE)
2. Verify agent-MCP communication patterns
3. Test parallel build loops with worktree isolation
4. Test review → revise → retry cycles
5. Test error recovery (stuck detection, cost limits, conflicts)

## Design Decisions

- **Mock agents entirely**: Simulate agent responses with predefined MCP tool calls. Fast, deterministic, free.
- **Happy paths + critical errors**: Test successful flows plus key failure modes.
- **Test fixtures with MockAgentFactory**: Composable, reusable mock behaviors.

## Architecture

```
src/__integration__/
├── fixtures/
│   ├── mock-agent.ts           # MockAgentFactory - simulates agent responses
│   ├── mock-mcp-calls.ts       # Predefined MCP tool call sequences per phase
│   └── test-specs.ts           # Sample spec files for different scenarios
├── helpers/
│   ├── orchestrator-harness.ts # Wraps orchestrator with mock injection
│   └── assertions.ts           # Custom assertions for state validation
├── flows/
│   ├── full-orchestration.test.ts   # End-to-end phase flows
│   ├── parallel-build.test.ts       # Parallel loops, worktrees, merging
│   ├── review-revise.test.ts        # Review→Revise→Retry cycles
│   └── error-recovery.test.ts       # Stuck detection, cost limits, conflicts
└── README.md                   # How to add new integration tests
```

## MockAgentFactory

Replaces real agent spawning with controllable mock behavior:

```typescript
interface MockAgentConfig {
  phase: Phase;
  mcpCalls: MockMcpCall[];      // Sequence of MCP tool calls to emit
  exitCode?: number;            // Default 0
  error?: string;               // Simulate agent crash
  delayMs?: number;             // Simulate realistic timing
}

interface MockMcpCall {
  tool: string;                 // e.g., 'write_task', 'complete_task'
  args: Record<string, unknown>;
  delayMs?: number;             // Delay before this call
}

class MockAgentFactory {
  private configs: Map<Phase, MockAgentConfig[]> = new Map();

  // Register mock behavior for a phase
  forPhase(phase: Phase, config: MockAgentConfig): this;

  // Get the spawn function to inject into orchestrator
  getSpawnFn(): typeof spawnAgent;

  // Verify all expected calls were made
  assertAllCalled(): void;

  // Get recorded prompts for inspection
  getRecordedPrompts(): { phase: Phase; prompt: string }[];
}
```

Usage:

```typescript
const mockAgent = new MockAgentFactory()
  .forPhase('analyze', { mcpCalls: analyzeFixture.success })
  .forPhase('enumerate', { mcpCalls: enumerateFixture.twoTasks })
  .forPhase('plan', { mcpCalls: planFixture.singleGroup });
```

## MCP Call Fixtures

Predefined MCP call sequences for common scenarios:

```typescript
export const analyzeFixture = {
  success: [
    { tool: 'set_codebase_analysis', args: {
      projectType: 'node-typescript',
      techStack: ['typescript', 'node'],
      directoryStructure: 'src/ with flat modules',
      existingFeatures: ['basic CLI'],
      entryPoints: ['src/index.ts'],
      patterns: 'ES modules, async/await',
      summary: 'Small TypeScript CLI project'
    }}
  ],
  emptyProject: [
    { tool: 'set_codebase_analysis', args: {
      projectType: 'empty',
      techStack: [],
      directoryStructure: '',
      existingFeatures: [],
      entryPoints: [],
      patterns: '',
      summary: 'Empty project'
    }}
  ]
};

export const enumerateFixture = {
  twoTasks: [
    { tool: 'write_task', args: { id: 'task-1', title: 'Setup project', description: '...', dependencies: [], estimatedIterations: 3 }},
    { tool: 'write_task', args: { id: 'task-2', title: 'Add feature', description: '...', dependencies: ['task-1'], estimatedIterations: 5 }}
  ],
  singleTask: [
    { tool: 'write_task', args: { id: 'task-1', title: 'Simple change', description: '...', dependencies: [], estimatedIterations: 2 }}
  ]
};

export const planFixture = {
  singleGroup: [
    { tool: 'add_plan_group', args: { groupIndex: 0, taskIds: ['task-1'] }}
  ],
  twoGroups: [
    { tool: 'add_plan_group', args: { groupIndex: 0, taskIds: ['task-1'] }},
    { tool: 'add_plan_group', args: { groupIndex: 1, taskIds: ['task-2'] }}
  ],
  parallelGroup: [
    { tool: 'add_plan_group', args: { groupIndex: 0, taskIds: ['task-1', 'task-2'] }}
  ]
};

export const buildFixture = {
  completeTask: (taskId: string) => [
    { tool: 'complete_task', args: { taskId }}
  ],
  failTask: (taskId: string, reason: string) => [
    { tool: 'fail_task', args: { taskId, reason }}
  ]
};

export const reviewFixture = {
  pass: [
    { tool: 'set_review_result', args: {
      interpretedIntent: 'Add the requested feature',
      intentSatisfied: true,
      passed: true,
      issues: []
    }}
  ],
  fail: (issues: Array<{ file: string; description: string }>) => [
    { tool: 'set_review_result', args: {
      interpretedIntent: 'Add the requested feature',
      intentSatisfied: false,
      passed: false,
      issues
    }}
  ]
};
```

## Orchestrator Test Harness

Wraps orchestrator with mock injection and test utilities:

```typescript
interface HarnessOptions {
  spec: string;                      // Spec content (not path)
  effort?: EffortLevel;              // Default 'low' for fast tests
  mockAgent: MockAgentFactory;
  useWorktrees?: boolean;            // Default false for unit-style tests
  initialPhase?: Phase;              // Start from specific phase
}

class OrchestratorHarness {
  private state: OrchestratorState;
  private tempDir: string;

  static async create(options: HarnessOptions): Promise<OrchestratorHarness>;

  // Run until specific phase completes
  async runUntilPhase(phase: Phase): Promise<OrchestratorState>;

  // Run single phase transition
  async runOnePhase(): Promise<OrchestratorState>;

  // Run to completion
  async runToCompletion(): Promise<OrchestratorState>;

  // State inspection
  getState(): OrchestratorState;
  getTasks(): Task[];
  getLoops(): LoopState[];
  getPhaseHistory(): PhaseHistoryEntry[];

  // Cleanup temp files and database
  async cleanup(): Promise<void>;
}
```

## Custom Assertions

```typescript
export function assertPhaseCompleted(state: OrchestratorState, phase: Phase): void;
export function assertTaskStatus(state: OrchestratorState, taskId: string, status: TaskStatus): void;
export function assertLoopStatus(state: OrchestratorState, loopId: string, status: LoopStatus): void;
export function assertNoStuckLoops(state: OrchestratorState): void;
export function assertCostWithinLimit(state: OrchestratorState, maxCost: number): void;
```

## Test Scenarios

### Full Orchestration Flows (`flows/full-orchestration.test.ts`)

| Test | Description |
|------|-------------|
| `completes simple spec end-to-end` | Single task, no dependencies, happy path |
| `handles multi-task spec with dependencies` | Task graph with parallel groups |
| `respects effort level review checkpoints` | Reviews trigger at correct phases |
| `persists and resumes from any phase` | Kill mid-run, resume with --resume |

### Parallel Build Loops (`flows/parallel-build.test.ts`)

| Test | Description |
|------|-------------|
| `runs independent tasks in parallel` | Two loops execute concurrently |
| `respects task dependencies across groups` | Group 1 waits for group 0 |
| `merges worktree changes to main` | Verify git history after merge |
| `detects and resolves merge conflicts` | Two loops modify same file |
| `handles one loop failing while others succeed` | Partial completion |

### Review-Revise Cycles (`flows/review-revise.test.ts`)

| Test | Description |
|------|-------------|
| `passes review on first attempt` | Clean implementation |
| `fails review and triggers revise` | Issues found, revision created |
| `retries build with revision feedback` | Feedback injected into prompt |
| `gives up after max revisions` | Marks stuck, doesn't loop forever |

### Error Recovery (`flows/error-recovery.test.ts`)

| Test | Description |
|------|-------------|
| `detects stuck loop from repeated errors` | Same error N times |
| `detects stuck loop from no progress` | No file changes |
| `enforces per-loop cost limit` | Stops loop, continues others |
| `enforces per-run cost limit` | Halts entire orchestration |
| `recovers from agent crash` | Non-zero exit code handling |

## Implementation Notes

### Injecting Mock Agents

The orchestrator's `spawnAgent` function needs to be injectable. Options:

1. **Dependency injection**: Pass spawn function as parameter to orchestrator
2. **Module mocking**: Use Node's module system to replace the import
3. **Configuration object**: Add `agentFactory` to orchestrator options

Recommend option 1 (dependency injection) for explicit, testable code.

### Running Integration Tests

Integration tests will run with the standard test command but can be filtered:

```bash
npm test                                           # All tests
npx tsx --test src/__integration__/**/*.test.ts   # Integration only
```

### CI Considerations

- Integration tests create temp directories and git repos
- All cleanup happens in `afterEach` hooks
- Tests should complete in < 10 seconds total
- No external dependencies (no network, no real agents)

## Success Criteria

1. All 18 integration tests pass
2. Tests run in < 10 seconds
3. Tests are deterministic (no flakiness)
4. Tests catch regressions in phase transitions
5. Tests document expected orchestration behavior
