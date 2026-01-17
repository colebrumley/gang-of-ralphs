import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

export function createDatabase(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  return db;
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call createDatabase first.');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Helper to get current run
export function getCurrentRun(runId: string) {
  return getDatabase().prepare('SELECT * FROM runs WHERE id = ?').get(runId);
}

// Helper to update run phase
export function updateRunPhase(runId: string, phase: string) {
  getDatabase().prepare(`
    UPDATE runs SET phase = ?, updated_at = datetime('now') WHERE id = ?
  `).run(phase, runId);
}

// Helper to get all tasks for a run
export function getTasksForRun(runId: string) {
  return getDatabase().prepare('SELECT * FROM tasks WHERE run_id = ?').all(runId);
}

// Helper to get active loops for a run
export function getActiveLoops(runId: string) {
  return getDatabase().prepare(`
    SELECT * FROM loops WHERE run_id = ? AND status IN ('pending', 'running')
  `).all(runId);
}

// Helper to create a new run
export function createRun(
  runId: string,
  specPath: string,
  effort: string,
  maxLoops: number = 4,
  maxIterations: number = 20
) {
  getDatabase().prepare(`
    INSERT INTO runs (id, spec_path, effort, max_loops, max_iterations)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, specPath, effort, maxLoops, maxIterations);
}

// Helper to get plan groups for a run
export function getPlanGroups(runId: string) {
  return getDatabase()
    .prepare('SELECT * FROM plan_groups WHERE run_id = ? ORDER BY group_index')
    .all(runId) as { run_id: string; group_index: number; task_ids: string }[];
}

// Helper to record cost
export function recordCost(runId: string, costUsd: number, loopId?: string) {
  const db = getDatabase();
  if (loopId) {
    db.prepare(`
      UPDATE loops SET cost_usd = cost_usd + ? WHERE id = ?
    `).run(costUsd, loopId);
  }
  db.prepare(`
    UPDATE runs SET total_cost_usd = total_cost_usd + ? WHERE id = ?
  `).run(costUsd, runId);
}

// Helper to add context entry
export function addContextEntry(
  runId: string,
  type: 'discovery' | 'error' | 'decision',
  content: string
) {
  getDatabase().prepare(`
    INSERT INTO context_entries (run_id, entry_type, content)
    VALUES (?, ?, ?)
  `).run(runId, type, content);
}

// Helper to get context entries
export function getContextEntries(runId: string, type?: string) {
  if (type) {
    return getDatabase()
      .prepare('SELECT * FROM context_entries WHERE run_id = ? AND entry_type = ?')
      .all(runId, type);
  }
  return getDatabase()
    .prepare('SELECT * FROM context_entries WHERE run_id = ?')
    .all(runId);
}
