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
  intent_satisfied INTEGER,
  was_empty_project INTEGER  -- NULL means not yet checked, 0 = false, 1 = true
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'stuck', 'completed', 'failed', 'interrupted')),
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

-- Context: unified storage for all context types
CREATE TABLE IF NOT EXISTS context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  type TEXT NOT NULL CHECK (type IN ('discovery', 'error', 'decision', 'review_issue', 'scratchpad', 'codebase_analysis')),
  content TEXT NOT NULL,
  task_id TEXT,
  loop_id TEXT,
  file TEXT,
  line INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_context_run ON context(run_id);
CREATE INDEX IF NOT EXISTS idx_context_type ON context(run_id, type);
CREATE INDEX IF NOT EXISTS idx_context_task ON context(run_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_loop ON context(run_id, loop_id) WHERE loop_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_file ON context(run_id, file) WHERE file IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_context_created ON context(run_id, created_at DESC);

-- FTS5 for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  content,
  content='context',
  content_rowid='id'
);

-- Keep FTS in sync with main table
CREATE TRIGGER IF NOT EXISTS context_fts_insert AFTER INSERT ON context BEGIN
  INSERT INTO context_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS context_fts_delete AFTER DELETE ON context BEGIN
  INSERT INTO context_fts(context_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- Loop reviews: per-loop review results
CREATE TABLE IF NOT EXISTS loop_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  loop_id TEXT NOT NULL REFERENCES loops(id),
  task_id TEXT,                           -- which task was reviewed (null for checkpoint reviews)
  passed INTEGER NOT NULL,                -- 0 or 1
  interpreted_intent TEXT,
  intent_satisfied INTEGER,               -- 0, 1, or null
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  cost_usd REAL DEFAULT 0
);

-- Phase costs: accumulated costs per phase per run
CREATE TABLE IF NOT EXISTS phase_costs (
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT NOT NULL CHECK (phase IN ('analyze', 'enumerate', 'plan', 'build', 'review', 'revise', 'conflict', 'complete')),
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, phase)
);

-- Pending conflicts: merge conflicts waiting for resolution
CREATE TABLE IF NOT EXISTS pending_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  loop_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  conflict_files TEXT NOT NULL, -- JSON array of file paths
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_loops_run ON loops(run_id);
CREATE INDEX IF NOT EXISTS idx_phase_history_run ON phase_history(run_id);
CREATE INDEX IF NOT EXISTS idx_phase_costs_run ON phase_costs(run_id);
CREATE INDEX IF NOT EXISTS idx_loop_reviews_run ON loop_reviews(run_id);
CREATE INDEX IF NOT EXISTS idx_loop_reviews_loop ON loop_reviews(loop_id);
CREATE INDEX IF NOT EXISTS idx_pending_conflicts_run ON pending_conflicts(run_id);
