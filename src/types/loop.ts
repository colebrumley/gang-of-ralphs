export interface StuckIndicators {
  sameErrorCount: number;
  noProgressCount: number;
  lastError: string | null;
  lastFileChangeIteration: number;
}

export interface LoopState {
  loopId: string;
  taskIds: string[];
  iteration: number;
  maxIterations: number;
  reviewInterval: number;
  lastReviewAt: number;
  status: 'pending' | 'running' | 'stuck' | 'completed' | 'failed';
  stuckIndicators: StuckIndicators;
  output: string[]; // Recent output lines for TUI
  worktreePath: string | null; // Path to git worktree (null if not using worktrees)
  phase: string; // Phase that created this loop (typically 'build')
}
