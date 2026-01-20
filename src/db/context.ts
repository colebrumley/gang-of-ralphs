import type { Database } from 'better-sqlite3';

export interface WriteContextOptions {
  runId: string;
  type: 'discovery' | 'error' | 'decision' | 'review_issue' | 'scratchpad' | 'codebase_analysis';
  content: string;
  taskId?: string;
  loopId?: string;
  file?: string;
  line?: number;
}

export function writeContextToDb(db: Database, entry: WriteContextOptions): { id: number } {
  const result = db
    .prepare(`
    INSERT INTO context (run_id, type, content, task_id, loop_id, file, line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      entry.runId,
      entry.type,
      entry.content,
      entry.taskId ?? null,
      entry.loopId ?? null,
      entry.file ?? null,
      entry.line ?? null
    );
  return { id: Number(result.lastInsertRowid) };
}

export interface ReadContextOptions {
  runId: string;
  types?: string[];
  taskId?: string;
  loopId?: string;
  file?: string;
  search?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface ContextEntry {
  id: number;
  type: string;
  content: string;
  task_id: string | null;
  loop_id: string | null;
  file: string | null;
  line: number | null;
  created_at: string;
}

export interface ReadContextResult {
  entries: ContextEntry[];
  total: number;
}

export function readContextFromDb(db: Database, opts: ReadContextOptions): ReadContextResult {
  const {
    runId,
    types,
    taskId,
    loopId,
    file,
    search,
    limit = 500,
    offset = 0,
    order = 'desc',
  } = opts;

  const conditions: string[] = ['c.run_id = ?'];
  const params: unknown[] = [runId];

  if (types?.length) {
    conditions.push(`c.type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (taskId) {
    conditions.push('c.task_id = ?');
    params.push(taskId);
  }
  if (loopId) {
    conditions.push('c.loop_id = ?');
    params.push(loopId);
  }
  if (file) {
    conditions.push('c.file = ?');
    params.push(file);
  }

  const whereClause = conditions.join(' AND ');
  let query: string;
  let countQuery: string;

  if (search) {
    // FTS5 has special query syntax - certain characters like (), *, ", AND, OR, NOT
    // can cause syntax errors. We try FTS5 first, then fall back to LIKE if it fails.
    try {
      query = `
        SELECT c.* FROM context c
        JOIN context_fts fts ON c.id = fts.rowid
        WHERE ${whereClause}
          AND context_fts MATCH ?
        ORDER BY rank, c.created_at ${order.toUpperCase()}, c.id ${order.toUpperCase()}
        LIMIT ? OFFSET ?
      `;
      countQuery = `
        SELECT COUNT(*) as total FROM context c
        JOIN context_fts fts ON c.id = fts.rowid
        WHERE ${whereClause}
          AND context_fts MATCH ?
      `;
      const entries = db.prepare(query).all(...params, search, limit, offset) as ContextEntry[];
      const { total } = db.prepare(countQuery).get(...params, search) as { total: number };
      return { entries, total };
    } catch {
      // FTS5 query failed (likely due to special characters in search term)
      // Fall back to simple LIKE search
      query = `
        SELECT * FROM context c
        WHERE ${whereClause}
          AND c.content LIKE ?
        ORDER BY c.created_at ${order.toUpperCase()}, c.id ${order.toUpperCase()}
        LIMIT ? OFFSET ?
      `;
      countQuery = `
        SELECT COUNT(*) as total FROM context c
        WHERE ${whereClause}
          AND c.content LIKE ?
      `;
      const likePattern = `%${search}%`;
      const entries = db
        .prepare(query)
        .all(...params, likePattern, limit, offset) as ContextEntry[];
      const { total } = db.prepare(countQuery).get(...params, likePattern) as { total: number };
      return { entries, total };
    }
  }

  query = `
    SELECT * FROM context c
    WHERE ${whereClause}
    ORDER BY c.created_at ${order.toUpperCase()}, c.id ${order.toUpperCase()}
    LIMIT ? OFFSET ?
  `;
  countQuery = `
    SELECT COUNT(*) as total FROM context c
    WHERE ${whereClause}
  `;
  const entries = db.prepare(query).all(...params, limit, offset) as ContextEntry[];
  const { total } = db.prepare(countQuery).get(...params) as { total: number };
  return { entries, total };
}

export function pruneContext(db: Database, runId: string, maxPerType = 500): void {
  const types = ['discovery', 'error', 'decision', 'review_issue', 'scratchpad'];

  for (const type of types) {
    db.prepare(`
      DELETE FROM context
      WHERE run_id = ? AND type = ? AND id NOT IN (
        SELECT id FROM context
        WHERE run_id = ? AND type = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
    `).run(runId, type, runId, type, maxPerType);
  }
}
