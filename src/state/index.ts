import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EffortLevel, OrchestratorState, Task, LoopState, Phase, ReviewType } from '../types/index.js';
import { getEffortConfig } from '../config/effort.js';
import { createDatabase, getDatabase, closeDatabase } from '../db/index.js';

export interface InitStateOptions {
  specPath: string;
  effort: EffortLevel;
  stateDir: string;
  maxLoops: number;
  maxIterations: number;
  useWorktrees?: boolean;
}

function getBaseBranch(): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' })
      .toString()
      .trim();
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
    pendingConflict: null,
  };
}

export function saveRun(state: OrchestratorState): void {
  const db = getDatabase();

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
  const run = db.prepare(`
    SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1
  `).get() as {
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
  } | undefined;

  if (!run) {
    closeDatabase();
    return null;
  }

  // Load tasks
  const taskRows = db.prepare(`
    SELECT * FROM tasks WHERE run_id = ?
  `).all(run.id) as Array<{
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    dependencies: string;
    estimated_iterations: number;
    assigned_loop_id: string | null;
  }>;

  const tasks: Task[] = taskRows.map(row => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dependencies: JSON.parse(row.dependencies),
    estimatedIterations: row.estimated_iterations,
    assignedLoopId: row.assigned_loop_id,
  }));

  // Load plan groups
  const planGroupRows = db.prepare(`
    SELECT * FROM plan_groups WHERE run_id = ? ORDER BY group_index
  `).all(run.id) as Array<{ task_ids: string }>;

  const parallelGroups = planGroupRows.map(row => JSON.parse(row.task_ids) as string[]);

  // Load loops
  const loopRows = db.prepare(`
    SELECT * FROM loops WHERE run_id = ?
  `).all(run.id) as Array<{
    id: string;
    task_ids: string;
    iteration: number;
    max_iterations: number;
    review_interval: number;
    last_review_at: number;
    status: 'pending' | 'running' | 'stuck' | 'completed' | 'failed';
    same_error_count: number;
    no_progress_count: number;
    last_error: string | null;
    last_file_change_iteration: number;
    worktree_path: string | null;
    cost_usd: number;
  }>;

  const activeLoops: LoopState[] = loopRows
    .filter(row => row.status !== 'completed' && row.status !== 'failed')
    .map(row => ({
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
      },
      output: [],
      worktreePath: row.worktree_path,
    }));

  // Load phase history
  const historyRows = db.prepare(`
    SELECT * FROM phase_history WHERE run_id = ? ORDER BY created_at
  `).all(run.id) as Array<{
    phase: Phase;
    success: number;
    summary: string;
    created_at: string;
  }>;

  const phaseHistory = historyRows.map(row => ({
    phase: row.phase,
    success: row.success === 1,
    timestamp: row.created_at,
    summary: row.summary,
  }));

  // Load context entries
  const contextRows = db.prepare(`
    SELECT * FROM context_entries WHERE run_id = ?
  `).all(run.id) as Array<{
    entry_type: 'discovery' | 'error' | 'decision';
    content: string;
  }>;

  const discoveries: string[] = [];
  const errors: string[] = [];
  const decisions: string[] = [];
  for (const row of contextRows) {
    if (row.entry_type === 'discovery') discoveries.push(row.content);
    else if (row.entry_type === 'error') errors.push(row.content);
    else if (row.entry_type === 'decision') decisions.push(row.content);
  }

  // Get completed task IDs
  const completedTasks = tasks.filter(t => t.status === 'completed').map(t => t.id);

  // Get effort config for cost limits
  const effortConfig = getEffortConfig(run.effort);

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
      reviewIssues: [],
    },
    costs: {
      totalCostUsd: run.total_cost_usd,
      phaseCosts: {
        enumerate: 0,
        plan: 0,
        build: 0,
        review: 0,
        revise: 0,
        conflict: 0,
        complete: 0,
      },
      loopCosts: Object.fromEntries(
        loopRows.map(row => [row.id, row.cost_usd])
      ),
    },
    costLimits: effortConfig.costLimits,
    maxLoops: run.max_loops,
    maxIterations: run.max_iterations,
    stateDir,
    baseBranch: run.base_branch,
    useWorktrees: run.use_worktrees === 1,
    pendingConflict: null,
  };
}

export { OrchestratorStateSchema } from './schema.js';
