import { describe, it } from 'node:test';
import assert from 'node:assert';
import { printDryRunSummary } from './summary.js';
import type { OrchestratorState } from '../types/index.js';

describe('Dry Run Summary', () => {
  it('prints summary without errors for valid state', () => {
    const mockState: OrchestratorState = {
      runId: 'test-123',
      specPath: '/test/spec.md',
      effort: 'medium',
      phase: 'build',
      phaseHistory: [],
      tasks: [
        {
          id: '1',
          title: 'Create user model',
          description: 'Create the user model with validation',
          status: 'pending',
          dependencies: [],
          estimatedIterations: 2,
          assignedLoopId: null,
        },
        {
          id: '2',
          title: 'Add API endpoint',
          description: 'Add REST endpoint for users',
          status: 'pending',
          dependencies: ['1'],
          estimatedIterations: 2,
          assignedLoopId: null,
        },
      ],
      taskGraph: {
        tasks: [],
        parallelGroups: [['1'], ['2']],
      },
      activeLoops: [],
      completedTasks: [],
      pendingReview: false,
      reviewType: null,
      revisionCount: 0,
      context: {
        discoveries: [],
        errors: [],
        decisions: [],
        reviewIssues: [],
      },
      costs: {
        totalCostUsd: 0,
        phaseCosts: {
          enumerate: 0,
          plan: 0,
          build: 0,
          review: 0,
          revise: 0,
          conflict: 0,
          complete: 0,
        },
        loopCosts: {},
      },
      costLimits: {
        perLoopMaxUsd: 10,
        perPhaseMaxUsd: 20,
        perRunMaxUsd: 100,
      },
      maxLoops: 5,
      maxIterations: 10,
      stateDir: '/test/.sq',
      baseBranch: 'main',
      useWorktrees: true,
      pendingConflict: null,
    };

    // Should not throw
    assert.doesNotThrow(() => printDryRunSummary(mockState));
  });

  it('handles state without taskGraph', () => {
    const mockState: OrchestratorState = {
      runId: 'test-123',
      specPath: '/test/spec.md',
      effort: 'medium',
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
        reviewIssues: [],
      },
      costs: {
        totalCostUsd: 0,
        phaseCosts: {
          enumerate: 0,
          plan: 0,
          build: 0,
          review: 0,
          revise: 0,
          conflict: 0,
          complete: 0,
        },
        loopCosts: {},
      },
      costLimits: {
        perLoopMaxUsd: 10,
        perPhaseMaxUsd: 20,
        perRunMaxUsd: 100,
      },
      maxLoops: 5,
      maxIterations: 10,
      stateDir: '/test/.sq',
      baseBranch: 'main',
      useWorktrees: true,
      pendingConflict: null,
    };

    // Should not throw
    assert.doesNotThrow(() => printDryRunSummary(mockState));
  });
});
