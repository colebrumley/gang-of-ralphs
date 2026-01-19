import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getEffortConfig } from '../config/effort.js';
import { closeDatabase, createDatabase, getDatabase } from '../db/index.js';

/**
 * Maximum number of context entries to keep per type (discovery, error, decision).
 * Prevents unbounded memory growth in long-running orchestration sessions.
 * Older entries beyond this limit are pruned from the database.
 */
export const MAX_CONTEXT_ENTRIES_PER_TYPE = 500;

/**
 * Maximum number of review issues to keep in memory.
 * Older issues beyond this limit are pruned from the database.
 */
export const MAX_REVIEW_ISSUES = 500;

import type {
  EffortLevel,
  LoopReviewStatus,
  LoopState,
  OrchestratorState,
  Phase,
  ReviewIssue,
  ReviewIssueType,
  ReviewType,
  Task,
} from '../types/index.js';

export interface InitStateOptions {
  specPath: string;
  effort: EffortLevel;
  stateDir: string;
  maxLoops: number;
  maxIterations: number;
  useWorktrees?: boolean;
  debug?: boolean;
}

function getBaseBranch(): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }).toString().trim();
  } catch {
    return null; // Not a git repo
  }
}

function isGitClean(): boolean {
  try {
    execSync('git diff --quiet && git diff --cached --quiet', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function initializeState(options: InitStateOptions): OrchestratorState {
  const effortConfig = getEffortConfig(options.effort);
  const baseBranch = getBaseBranch();
  const useWorktrees = options.useWorktrees !== false && baseBranch !== null;

  if (useWorktrees && !isGitClean()) {
    throw new Error('Cannot run sq with uncommitted changes - commit or stash first');
  }

  return {
    runId: randomUUID(),
    specPath: options.specPath,
    effort: options.effort,
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
    costLimits: effortConfig.costLimits,
    maxLoops: options.maxLoops,
    maxIterations: options.maxIterations,
    stateDir: options.stateDir,
    baseBranch,
    useWorktrees,
    debug: options.debug ?? false,
    pendingConflicts: [],
  };
}

export function saveRun(state: OrchestratorState): void {
  const db = getDatabase();

  // Wrap all state persistence in a transaction for atomicity
  // This prevents database corruption if a crash occurs mid-save
  const saveTransaction = db.transaction(() => {
    // Check if run exists
    const existing = db.prepare('SELECT id FROM runs WHERE id = ?').get(state.runId);

    if (existing) {
      // Update existing run
      db.prepare(`
        UPDATE runs SET
          phase = ?,
          pending_review = ?,
          review_type = ?,
          revision_count = ?,
          total_cost_usd = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        state.phase,
        state.pendingReview ? 1 : 0,
        state.reviewType,
        state.revisionCount,
        state.costs.totalCostUsd,
        state.runId
      );
    } else {
      // Insert new run
      db.prepare(`
        INSERT INTO runs (id, spec_path, effort, phase, pending_review, review_type, revision_count,
          max_loops, max_iterations, total_cost_usd, base_branch, use_worktrees)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.runId,
        state.specPath,
        state.effort,
        state.phase,
        state.pendingReview ? 1 : 0,
        state.reviewType,
        state.revisionCount,
        state.maxLoops,
        state.maxIterations,
        state.costs.totalCostUsd,
        state.baseBranch,
        state.useWorktrees ? 1 : 0
      );
    }

    // Persist task status to database
    saveTasks(state);

    // Persist loops to database
    saveLoops(state);

    // Persist phase history to database
    savePhaseHistory(state);

    // Persist phase costs to database
    savePhaseCosts(state);

    // Persist pending conflicts to database
    savePendingConflicts(state);
  });

  saveTransaction();
}

/**
 * Persist task statuses to the database.
 * Updates tasks in completedTasks to have status 'completed'.
 * Also syncs failed task status from state.tasks array.
 */
function saveTasks(state: OrchestratorState): void {
  const db = getDatabase();

  const completedSet = new Set(state.completedTasks);

  // Update all tasks, preferring completedTasks status over state.tasks status
  const stmt = db.prepare(`
    UPDATE tasks SET status = ?, assigned_loop_id = ? WHERE id = ? AND run_id = ?
  `);

  for (const task of state.tasks) {
    // Use 'completed' if in completedTasks, otherwise use task's own status
    const status = completedSet.has(task.id) ? 'completed' : task.status;
    stmt.run(status, task.assignedLoopId ?? null, task.id, state.runId);
  }
}

/**
 * Persist phase history entries to the database.
 * Only inserts entries that haven't been saved yet by checking count.
 */
function savePhaseHistory(state: OrchestratorState): void {
  const db = getDatabase();

  // Count existing entries for this run
  const result = db
    .prepare('SELECT COUNT(*) as count FROM phase_history WHERE run_id = ?')
    .get(state.runId) as { count: number };
  const existingCount = result.count;

  // Insert any new entries
  const stmt = db.prepare(`
    INSERT INTO phase_history (run_id, phase, success, summary, cost_usd)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (let i = existingCount; i < state.phaseHistory.length; i++) {
    const entry = state.phaseHistory[i];
    // Use the cost stored in the entry (incremental cost for this phase execution)
    stmt.run(state.runId, entry.phase, entry.success ? 1 : 0, entry.summary, entry.costUsd);
  }
}

/**
 * Persist phase costs to the database.
 * Uses upsert to handle both new and existing entries.
 */
function savePhaseCosts(state: OrchestratorState): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO phase_costs (run_id, phase, cost_usd)
    VALUES (?, ?, ?)
    ON CONFLICT(run_id, phase) DO UPDATE SET cost_usd = excluded.cost_usd
  `);

  for (const [phase, costUsd] of Object.entries(state.costs.phaseCosts)) {
    if (costUsd > 0) {
      stmt.run(state.runId, phase, costUsd);
    }
  }
}

/**
 * Persist all active loops to the database.
 * Uses INSERT OR REPLACE to handle both new loops and updates.
 */
function saveLoops(state: OrchestratorState): void {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO loops (
      id, run_id, task_ids, iteration, max_iterations, review_interval,
      last_review_at, status, same_error_count, no_progress_count,
      last_error, last_file_change_iteration, last_activity_at, cost_usd, worktree_path, phase
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const loop of state.activeLoops) {
    const costUsd = state.costs.loopCosts[loop.loopId] ?? 0;

    stmt.run(
      loop.loopId,
      state.runId,
      JSON.stringify(loop.taskIds),
      loop.iteration,
      loop.maxIterations,
      loop.reviewInterval,
      loop.lastReviewAt,
      loop.status,
      loop.stuckIndicators.sameErrorCount,
      loop.stuckIndicators.noProgressCount,
      loop.stuckIndicators.lastError,
      loop.stuckIndicators.lastFileChangeIteration,
      loop.stuckIndicators.lastActivityAt,
      costUsd,
      loop.worktreePath,
      loop.phase
    );
  }
}

/**
 * Persist pending conflicts to the database.
 * Replaces all existing conflicts with current state to handle both additions and removals.
 */
function savePendingConflicts(state: OrchestratorState): void {
  const db = getDatabase();

  // Delete all existing pending conflicts for this run
  db.prepare('DELETE FROM pending_conflicts WHERE run_id = ?').run(state.runId);

  // Insert current pending conflicts
  if (state.pendingConflicts.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO pending_conflicts (run_id, loop_id, task_id, conflict_files)
      VALUES (?, ?, ?, ?)
    `);

    for (const conflict of state.pendingConflicts) {
      stmt.run(
        state.runId,
        conflict.loopId,
        conflict.taskId,
        JSON.stringify(conflict.conflictFiles)
      );
    }
  }
}

/**
 * Prune old context entries from the database to prevent unbounded storage growth.
 * Keeps only the most recent MAX_CONTEXT_ENTRIES_PER_TYPE entries per type.
 */
function pruneContextEntries(db: ReturnType<typeof getDatabase>, runId: string): void {
  for (const entryType of ['discovery', 'error', 'decision']) {
    // Delete entries older than the Nth most recent entry for this type
    db.prepare(`
      DELETE FROM context_entries
      WHERE run_id = ? AND entry_type = ? AND id NOT IN (
        SELECT id FROM context_entries
        WHERE run_id = ? AND entry_type = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
    `).run(runId, entryType, runId, entryType, MAX_CONTEXT_ENTRIES_PER_TYPE);
  }
}

/**
 * Prune old review issues from the database to prevent unbounded storage growth.
 * Keeps only the most recent MAX_REVIEW_ISSUES entries.
 */
function pruneReviewIssues(db: ReturnType<typeof getDatabase>, runId: string): void {
  db.prepare(`
    DELETE FROM review_issues
    WHERE run_id = ? AND id NOT IN (
      SELECT id FROM review_issues
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(runId, runId, MAX_REVIEW_ISSUES);
}

export function loadState(stateDir: string): OrchestratorState | null {
  const dbPath = join(stateDir, 'state.db');
  if (!existsSync(dbPath)) {
    return null;
  }

  // Initialize database connection
  createDatabase(dbPath);
  const db = getDatabase();

  // Get most recent run
  const run = db
    .prepare(`
    SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1
  `)
    .get() as
    | {
        id: string;
        spec_path: string;
        effort: EffortLevel;
        phase: Phase;
        pending_review: number;
        review_type: string | null;
        revision_count: number;
        max_loops: number;
        max_iterations: number;
        total_cost_usd: number;
        base_branch: string | null;
        use_worktrees: number;
      }
    | undefined;

  if (!run) {
    closeDatabase();
    return null;
  }

  // Load tasks
  const taskRows = db
    .prepare(`
    SELECT * FROM tasks WHERE run_id = ?
  `)
    .all(run.id) as Array<{
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    dependencies: string;
    estimated_iterations: number;
    assigned_loop_id: string | null;
  }>;

  const tasks: Task[] = taskRows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dependencies: JSON.parse(row.dependencies),
    estimatedIterations: row.estimated_iterations,
    assignedLoopId: row.assigned_loop_id,
  }));

  // Load plan groups
  const planGroupRows = db
    .prepare(`
    SELECT * FROM plan_groups WHERE run_id = ? ORDER BY group_index
  `)
    .all(run.id) as Array<{ task_ids: string }>;

  const parallelGroups = planGroupRows.map((row) => JSON.parse(row.task_ids) as string[]);

  // Load loops
  const loopRows = db
    .prepare(`
    SELECT * FROM loops WHERE run_id = ?
  `)
    .all(run.id) as Array<{
    id: string;
    task_ids: string;
    iteration: number;
    max_iterations: number;
    review_interval: number;
    last_review_at: number;
    status: 'pending' | 'running' | 'stuck' | 'completed' | 'failed' | 'interrupted';
    same_error_count: number;
    no_progress_count: number;
    last_error: string | null;
    last_file_change_iteration: number;
    last_activity_at: number | null;
    worktree_path: string | null;
    cost_usd: number;
    phase: string;
  }>;

  // Load loop reviews to restore per-loop review state
  const loopReviewRows = db
    .prepare(`
    SELECT id, loop_id, passed FROM loop_reviews
    WHERE run_id = ? ORDER BY reviewed_at DESC
  `)
    .all(run.id) as Array<{
    id: string;
    loop_id: string;
    passed: number;
  }>;

  // Group reviews by loop_id (already sorted by reviewed_at DESC)
  const reviewsByLoop = new Map<string, typeof loopReviewRows>();
  for (const review of loopReviewRows) {
    const existing = reviewsByLoop.get(review.loop_id) || [];
    existing.push(review);
    reviewsByLoop.set(review.loop_id, existing);
  }

  const activeLoops: LoopState[] = loopRows
    .filter((row) => row.status !== 'completed' && row.status !== 'failed')
    .map((row) => {
      // Compute review state from loop_reviews table
      const reviews = reviewsByLoop.get(row.id) || [];
      const mostRecentReview = reviews[0]; // Already sorted DESC by reviewed_at

      let reviewStatus: LoopReviewStatus = 'pending';
      let lastReviewId: string | null = null;
      let revisionAttempts = 0;

      if (mostRecentReview) {
        lastReviewId = mostRecentReview.id;
        reviewStatus = mostRecentReview.passed ? 'passed' : 'failed';

        // Count consecutive failed reviews from the end
        if (!mostRecentReview.passed) {
          for (const review of reviews) {
            if (review.passed) break;
            revisionAttempts++;
          }
        }
      }

      return {
        loopId: row.id,
        taskIds: JSON.parse(row.task_ids),
        iteration: row.iteration,
        maxIterations: row.max_iterations,
        reviewInterval: row.review_interval,
        lastReviewAt: row.last_review_at,
        status: row.status,
        stuckIndicators: {
          sameErrorCount: row.same_error_count,
          noProgressCount: row.no_progress_count,
          lastError: row.last_error,
          lastFileChangeIteration: row.last_file_change_iteration,
          lastActivityAt: row.last_activity_at ?? Date.now(),
        },
        output: [],
        worktreePath: row.worktree_path,
        phase: row.phase ?? 'build',
        // Per-loop review tracking (restored from loop_reviews table)
        reviewStatus,
        lastReviewId,
        revisionAttempts,
        lastCheckpointReviewAt: 0, // Reset on resume - will trigger checkpoint sooner if needed
      };
    });

  // Load phase history
  const historyRows = db
    .prepare(`
    SELECT * FROM phase_history WHERE run_id = ? ORDER BY created_at
  `)
    .all(run.id) as Array<{
    phase: Phase;
    success: number;
    summary: string;
    cost_usd: number;
    created_at: string;
  }>;

  const phaseHistory = historyRows.map((row) => ({
    phase: row.phase,
    success: row.success === 1,
    timestamp: row.created_at,
    summary: row.summary,
    costUsd: row.cost_usd ?? 0,
  }));

  // Load context entries with limits to prevent unbounded memory growth
  // Load only the most recent entries per type, ordered oldest-first for chronological display
  const loadContextEntries = (entryType: string): string[] => {
    const rows = db
      .prepare(`
        SELECT content FROM (
          SELECT content, created_at FROM context_entries
          WHERE run_id = ? AND entry_type = ?
          ORDER BY created_at DESC
          LIMIT ?
        ) ORDER BY created_at ASC
      `)
      .all(run.id, entryType, MAX_CONTEXT_ENTRIES_PER_TYPE) as Array<{ content: string }>;
    return rows.map((row) => row.content);
  };

  const discoveries = loadContextEntries('discovery');
  const errors = loadContextEntries('error');
  const decisions = loadContextEntries('decision');

  // Prune old context entries from database to prevent unbounded storage growth
  pruneContextEntries(db, run.id);

  // Load review issues with limit to prevent unbounded memory growth
  // Most recent issues are most relevant, so load newest first then reverse for chronological order
  const reviewIssueRows = db
    .prepare(`
    SELECT * FROM (
      SELECT * FROM review_issues WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    ) ORDER BY created_at ASC
  `)
    .all(run.id, MAX_REVIEW_ISSUES) as Array<{
    task_id: string;
    file: string;
    line: number | null;
    type: ReviewIssueType;
    description: string;
    suggestion: string;
  }>;

  const reviewIssues: ReviewIssue[] = reviewIssueRows.map((row) => ({
    taskId: row.task_id,
    file: row.file,
    line: row.line ?? undefined,
    type: row.type,
    description: row.description,
    suggestion: row.suggestion,
  }));

  // Prune old review issues from database to prevent unbounded storage growth
  pruneReviewIssues(db, run.id);

  // Get completed task IDs
  const completedTasks = tasks.filter((t) => t.status === 'completed').map((t) => t.id);

  // Get effort config for cost limits
  const effortConfig = getEffortConfig(run.effort);

  // Load phase costs from database
  const phaseCostRows = db
    .prepare(`
    SELECT phase, cost_usd FROM phase_costs WHERE run_id = ?
  `)
    .all(run.id) as Array<{ phase: Phase; cost_usd: number }>;

  const phaseCosts: Record<Phase, number> = {
    enumerate: 0,
    plan: 0,
    build: 0,
    review: 0,
    revise: 0,
    conflict: 0,
    complete: 0,
  };
  for (const row of phaseCostRows) {
    phaseCosts[row.phase] = row.cost_usd;
  }

  // Load pending conflicts from database
  const pendingConflictRows = db
    .prepare(`
    SELECT loop_id, task_id, conflict_files FROM pending_conflicts
    WHERE run_id = ? ORDER BY id
  `)
    .all(run.id) as Array<{
    loop_id: string;
    task_id: string;
    conflict_files: string;
  }>;

  const pendingConflicts = pendingConflictRows.map((row) => ({
    loopId: row.loop_id,
    taskId: row.task_id,
    conflictFiles: JSON.parse(row.conflict_files) as string[],
  }));

  return {
    runId: run.id,
    specPath: run.spec_path,
    effort: run.effort,
    phase: run.phase,
    phaseHistory,
    tasks,
    taskGraph: parallelGroups.length > 0 ? { tasks, parallelGroups } : null,
    activeLoops,
    completedTasks,
    pendingReview: run.pending_review === 1,
    reviewType: run.review_type as ReviewType,
    revisionCount: run.revision_count,
    context: {
      discoveries,
      errors,
      decisions,
      reviewIssues,
    },
    costs: {
      totalCostUsd: run.total_cost_usd,
      phaseCosts,
      loopCosts: Object.fromEntries(loopRows.map((row) => [row.id, row.cost_usd])),
    },
    costLimits: effortConfig.costLimits,
    maxLoops: run.max_loops,
    maxIterations: run.max_iterations,
    stateDir,
    baseBranch: run.base_branch,
    useWorktrees: run.use_worktrees === 1,
    debug: false, // Runtime option, not persisted
    pendingConflicts,
  };
}

export { OrchestratorStateSchema } from './schema.js';
