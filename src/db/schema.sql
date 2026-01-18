-- Runs table: one row per orchestrator invocation
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  spec_path TEXT NOT NULL,
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'max')),
  phase TEXT NOT NULL DEFAULT 'enumerate',
  pending_review INTEGER NOT NULL DEFAULT 0,
  review_type TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  max_loops INTEGER NOT NULL DEFAULT 4,
  max_iterations INTEGER NOT NULL DEFAULT 20,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  base_branch TEXT,
  use_worktrees INTEGER NOT NULL DEFAULT 1,
  interpreted_intent TEXT,
  intent_satisfied INTEGER
);

-- Tasks table: enumerated tasks for a run
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  dependencies TEXT NOT NULL DEFAULT '[]', -- JSON array of task IDs
  estimated_iterations INTEGER NOT NULL DEFAULT 10,
  assigned_loop_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plan groups: parallel execution groups
CREATE TABLE IF NOT EXISTS plan_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  group_index INTEGER NOT NULL,
  task_ids TEXT NOT NULL, -- JSON array of task IDs
  UNIQUE(run_id, group_index)
);

-- Loops table: parallel execution loops
CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_ids TEXT NOT NULL, -- JSON array
  iteration INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL,
  review_interval INTEGER NOT NULL,
  last_review_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'stuck', 'completed', 'failed')),
  same_error_count INTEGER NOT NULL DEFAULT 0,
  no_progress_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_file_change_iteration INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  cost_usd REAL NOT NULL DEFAULT 0,
  worktree_path TEXT,
  phase TEXT NOT NULL DEFAULT 'build', -- Phase that created this loop
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase history: log of completed phases
CREATE TABLE IF NOT EXISTS phase_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT NOT NULL,
  success INTEGER NOT NULL,
  summary TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Context: discoveries, errors, decisions
CREATE TABLE IF NOT EXISTS context_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('discovery', 'error', 'decision')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Review issues: structured feedback from review phase
CREATE TABLE IF NOT EXISTS review_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  type TEXT NOT NULL CHECK (type IN ('over-engineering', 'missing-error-handling', 'pattern-violation', 'dead-code', 'spec-intent-mismatch')),
  description TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase costs: accumulated costs per phase per run
CREATE TABLE IF NOT EXISTS phase_costs (
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT NOT NULL CHECK (phase IN ('enumerate', 'plan', 'build', 'review', 'revise', 'conflict', 'complete')),
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, phase)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_loops_run ON loops(run_id);
CREATE INDEX IF NOT EXISTS idx_phase_history_run ON phase_history(run_id);
CREATE INDEX IF NOT EXISTS idx_review_issues_run ON review_issues(run_id);
CREATE INDEX IF NOT EXISTS idx_phase_costs_run ON phase_costs(run_id);
