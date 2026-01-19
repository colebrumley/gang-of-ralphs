import type { LoopState } from './loop.js';
import type { Task, TaskGraph } from './task.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export type Phase =
  | 'analyze'
  | 'enumerate'
  | 'plan'
  | 'build'
  | 'review'
  | 'revise'
  | 'conflict'
  | 'complete';
export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export type ReviewType = 'analyze' | 'enumerate' | 'plan' | 'build' | null;

export type ReviewIssueType =
  | 'over-engineering'
  | 'missing-error-handling'
  | 'pattern-violation'
  | 'dead-code'
  | 'spec-intent-mismatch'
  | 'architecture-concern';

export interface ReviewIssue {
  taskId?: string; // Optional: cross-task issues (architecture, patterns) have no taskId
  file: string;
  line?: number;
  type: ReviewIssueType;
  description: string;
  suggestion: string;
}

export interface CodebaseAnalysis {
  projectType: string; // e.g., "TypeScript Node.js application", "React frontend", "empty"
  techStack: string[]; // e.g., ["TypeScript", "Node.js", "SQLite", "React"]
  directoryStructure: string; // Brief description of organization
  existingFeatures: string[]; // What the codebase already does
  entryPoints: string[]; // Main entry files
  patterns: string[]; // Key patterns/conventions observed
  summary: string; // 2-3 sentence overall summary
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

  // Debug tracing
  debug: boolean;

  // Conflict resolution - array to handle multiple parallel loop conflicts
  pendingConflicts: Array<{
    loopId: string;
    taskId: string;
    conflictFiles: string[];
  }>;

  // Scaffolding detection - persisted once at run start to avoid race conditions
  // between ENUMERATE and PLAN phases (Risk #3 mitigation for scaffold detection)
  wasEmptyProject: boolean | null; // null means not yet checked

  // Codebase analysis from ANALYZE phase
  codebaseAnalysis: CodebaseAnalysis | null;
}
