export interface StuckIndicators {
  sameErrorCount: number;
  noProgressCount: number;
  lastError: string | null;
  lastFileChangeIteration: number;
  lastActivityAt: number; // Unix timestamp (ms) of last output received
}

export type LoopReviewStatus = 'pending' | 'in_progress' | 'passed' | 'failed';

export interface LoopState {
  loopId: string;
  taskIds: string[];
  iteration: number;
  maxIterations: number;
  reviewInterval: number;
  lastReviewAt: number;
  status: 'pending' | 'running' | 'stuck' | 'completed' | 'failed' | 'interrupted';
  stuckIndicators: StuckIndicators;
  output: string[]; // Recent output lines for TUI
  worktreePath: string | null; // Path to git worktree (null if not using worktrees)
  phase: string; // Phase that created this loop (typically 'build')

  // Per-loop review tracking
  reviewStatus: LoopReviewStatus;
  lastReviewId: string | null; // References loop_reviews.id
  revisionAttempts: number; // Count of revision attempts for current task
  lastCheckpointReviewAt: number; // Iteration when last checkpoint review occurred
}
