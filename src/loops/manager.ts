import { randomUUID } from 'node:crypto';
import type { DebugTracer } from '../debug/index.js';
import type { LoopState, Task } from '../types/index.js';
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
    const activeCount = this.getActiveLoops().length + this.getPendingLoops().length;
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
}
