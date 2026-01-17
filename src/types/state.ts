import type { LoopState } from './loop.js';
import type { Task, TaskGraph } from './task.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export type Phase = 'enumerate' | 'plan' | 'build' | 'review' | 'revise' | 'conflict' | 'complete';
export type ReviewType = 'enumerate' | 'plan' | 'build' | null;

export type ReviewIssueType =
  | 'over-engineering'
  | 'missing-error-handling'
  | 'pattern-violation'
  | 'dead-code';

export interface ReviewIssue {
  taskId: string;
  file: string;
  line?: number;
  type: ReviewIssueType;
  description: string;
  suggestion: string;
}

export interface PhaseResult {
  phase: Phase;
  success: boolean;
  timestamp: string;
  summary: string;
  costUsd: number;
}

export interface OrchestratorContext {
  discoveries: string[];
  errors: string[];
  decisions: string[];
  reviewIssues: ReviewIssue[];
}

export interface CostTracking {
  totalCostUsd: number;
  phaseCosts: Record<Phase, number>;
  loopCosts: Record<string, number>; // loopId -> cost
}

export interface CostLimits {
  perLoopMaxUsd: number;
  perPhaseMaxUsd: number;
  perRunMaxUsd: number;
}

export interface OrchestratorState {
  // Identity
  runId: string;
  specPath: string;
  effort: EffortLevel;

  // Phase tracking
  phase: Phase;
  phaseHistory: PhaseResult[];

  // Task management
  tasks: Task[];
  taskGraph: TaskGraph | null;

  // Build tracking
  activeLoops: LoopState[];
  completedTasks: string[];

  // Review tracking
  pendingReview: boolean;
  reviewType: ReviewType;
  revisionCount: number;

  // Context for agents
  context: OrchestratorContext;

  // Cost tracking (Risk #3 mitigation)
  costs: CostTracking;
  costLimits: CostLimits;

  // Config
  maxLoops: number;
  maxIterations: number;
  stateDir: string;

  // Git worktree isolation
  baseBranch: string | null; // null if not a git repo
  useWorktrees: boolean;

  // Conflict resolution
  pendingConflict: {
    loopId: string;
    taskId: string;
    conflictFiles: string[];
  } | null;
}
