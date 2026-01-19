import { randomUUID } from 'node:crypto';
import type { DebugTracer } from '../debug/index.js';
import type { LoopReviewStatus, LoopState, Task } from '../types/index.js';
import type { WorktreeManager } from '../worktrees/manager.js';

export interface LoopManagerConfig {
  maxLoops: number;
  maxIterations: number;
  reviewInterval: number;
}

export class LoopManager {
  private loops: Map<string, LoopState> = new Map();
  private config: LoopManagerConfig;
  private worktreeManager: WorktreeManager | null;
  private tracer: DebugTracer | null;

  constructor(config: LoopManagerConfig, worktreeManager?: WorktreeManager, tracer?: DebugTracer) {
    this.config = config;
    this.worktreeManager = worktreeManager ?? null;
    this.tracer = tracer ?? null;
  }

  async createLoop(taskIds: string[], tasks: Task[], phase = 'build'): Promise<LoopState> {
    const loopId = randomUUID();
    let worktreePath: string | null = null;

    // Create worktree if manager is configured
    if (this.worktreeManager) {
      const result = await this.worktreeManager.create(loopId);
      worktreePath = result.worktreePath;
    }

    const loop: LoopState = {
      loopId,
      taskIds,
      iteration: 0,
      maxIterations: this.config.maxIterations,
      reviewInterval: this.config.reviewInterval,
      lastReviewAt: 0,
      status: 'pending',
      stuckIndicators: {
        sameErrorCount: 0,
        noProgressCount: 0,
        lastError: null,
        lastFileChangeIteration: 0,
        lastActivityAt: Date.now(),
      },
      output: [],
      worktreePath,
      phase,
      // Per-loop review tracking
      reviewStatus: 'pending',
      lastReviewId: null,
      revisionAttempts: 0,
      lastCheckpointReviewAt: 0,
    };

    this.loops.set(loopId, loop);

    // Update task assignments
    for (const task of tasks) {
      if (taskIds.includes(task.id)) {
        task.assignedLoopId = loopId;
      }
    }

    this.tracer?.logLoopCreated(loopId, taskIds, worktreePath);

    return loop;
  }

  getWorktreeManager(): WorktreeManager | null {
    return this.worktreeManager;
  }

  canSpawnMore(): boolean {
    // Count running, pending, and interrupted loops (interrupted will be restarted)
    const activeCount =
      this.getActiveLoops().length +
      this.getPendingLoops().length +
      this.getInterruptedLoops().length;
    return activeCount < this.config.maxLoops;
  }

  getLoop(loopId: string): LoopState | undefined {
    return this.loops.get(loopId);
  }

  getAllLoops(): LoopState[] {
    return Array.from(this.loops.values());
  }

  getActiveLoops(): LoopState[] {
    return this.getAllLoops().filter((l) => l.status === 'running');
  }

  getPendingLoops(): LoopState[] {
    return this.getAllLoops().filter((l) => l.status === 'pending');
  }

  getInterruptedLoops(): LoopState[] {
    return this.getAllLoops().filter((l) => l.status === 'interrupted');
  }

  updateLoopStatus(loopId: string, status: LoopState['status']): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      const previousStatus = loop.status;
      loop.status = status;
      if (previousStatus !== status) {
        this.tracer?.logLoopStatusChange(loopId, status, loop.taskIds);
      }
    }
  }

  incrementIteration(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.iteration++;
      this.tracer?.logLoopIteration(loopId, loop.iteration);
    }
  }

  needsReview(loopId: string): boolean {
    const loop = this.loops.get(loopId);
    if (!loop) return false;

    return loop.iteration - loop.lastReviewAt >= loop.reviewInterval;
  }

  markReviewed(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.lastReviewAt = loop.iteration;
    }
  }

  appendOutput(loopId: string, text: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.output.push(text);
      // Keep only last 100 lines for TUI
      if (loop.output.length > 100) {
        loop.output = loop.output.slice(-100);
      }
    }
  }

  /**
   * Update the last activity timestamp for a loop.
   * Called whenever output is received from the agent.
   */
  updateLastActivity(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.stuckIndicators.lastActivityAt = Date.now();
    }
  }

  /**
   * Restore a loop from persisted state (used when resuming BUILD phase).
   * This allows the orchestrator to restore loops that were active before
   * the process was interrupted.
   */
  restoreLoop(loop: LoopState): void {
    this.loops.set(loop.loopId, loop);
  }

  // ============================================================================
  // Per-Loop Review Methods
  // ============================================================================

  /**
   * Generate a summary of other loops for context during review.
   * Helps the reviewer understand what else is happening in parallel.
   */
  getOtherLoopsSummary(excludeLoopId: string, tasks: Task[]): string {
    const otherLoops = this.getAllLoops().filter((l) => l.loopId !== excludeLoopId);

    if (otherLoops.length === 0) {
      return '';
    }

    return otherLoops
      .map((loop) => {
        const taskTitles = loop.taskIds
          .map((id) => tasks.find((t) => t.id === id)?.title || id)
          .join(', ');

        const statusDesc =
          loop.status === 'completed'
            ? 'completed'
            : loop.status === 'running'
              ? `in_progress, iteration ${loop.iteration}`
              : loop.status;

        return `- Loop ${loop.loopId.slice(0, 8)} (${statusDesc}): ${taskTitles}`;
      })
      .join('\n');
  }

  /**
   * Check if any active loop needs a checkpoint review based on the interval.
   * Checkpoint reviews happen at iteration thresholds, even if the task isn't complete.
   */
  needsCheckpointReview(checkpointInterval: number | null): boolean {
    if (checkpointInterval === null) return false;

    return this.getActiveLoops().some(
      (loop) => loop.iteration - loop.lastCheckpointReviewAt >= checkpointInterval
    );
  }

  /**
   * Get loops that need checkpoint review.
   */
  getLoopsNeedingCheckpointReview(checkpointInterval: number | null): LoopState[] {
    if (checkpointInterval === null) return [];

    return this.getActiveLoops().filter(
      (loop) => loop.iteration - loop.lastCheckpointReviewAt >= checkpointInterval
    );
  }

  /**
   * Update the review status for a loop.
   */
  updateReviewStatus(loopId: string, status: LoopReviewStatus, reviewId?: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.reviewStatus = status;
      if (reviewId) {
        loop.lastReviewId = reviewId;
      }
    }
  }

  /**
   * Increment the revision attempts counter for a loop.
   * Called when a review fails and the loop needs to revise.
   */
  incrementRevisionAttempts(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.revisionAttempts++;
    }
  }

  /**
   * Reset the revision attempts counter for a loop.
   * Called when a review passes successfully.
   */
  resetRevisionAttempts(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.revisionAttempts = 0;
    }
  }

  /**
   * Mark when a checkpoint review occurred for a loop.
   */
  markCheckpointReviewed(loopId: string): void {
    const loop = this.loops.get(loopId);
    if (loop) {
      loop.lastCheckpointReviewAt = loop.iteration;
    }
  }

  /**
   * Check if a loop has exceeded max revision attempts.
   */
  hasExceededMaxRevisions(loopId: string, maxRevisionAttempts: number): boolean {
    const loop = this.loops.get(loopId);
    if (!loop) return false;
    return loop.revisionAttempts >= maxRevisionAttempts;
  }
}
