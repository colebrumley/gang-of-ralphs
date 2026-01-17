import type { Task, TaskGraph } from './task.js';
import type { LoopState } from './loop.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export type Phase = 'enumerate' | 'plan' | 'build' | 'review' | 'revise' | 'complete';
export type ReviewType = 'enumerate' | 'plan' | 'build' | null;

export interface PhaseResult {
  phase: Phase;
  success: boolean;
  timestamp: string;
  summary: string;
}

export interface OrchestratorContext {
  discoveries: string[];
  errors: string[];
  decisions: string[];
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

  // Config
  maxLoops: number;
  maxIterations: number;
  stateDir: string;
}
