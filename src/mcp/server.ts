import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readContextFromDb, writeContextToDb } from '../db/context.js';
import { getDatabase } from '../db/index.js';
import {
  AddPlanGroupSchema,
  CompleteTaskSchema,
  CreateLoopSchema,
  FailTaskSchema,
  PersistLoopStateSchema,
  ReadContextSchema,
  RecordCostSchema,
  RecordPhaseCostSchema,
  SetLoopReviewResultSchema,
  SetReviewResultSchema,
  UpdateLoopStatusSchema,
  WriteContextSchema,
  WriteTaskSchema,
} from './tools.js';

function createMcpLogger(dbPath: string, runId: string) {
  // Derive debug dir from dbPath: .sq/state.db -> .sq/debug/<runId>/mcp-calls.jsonl
  const stateDir = dirname(dbPath);
  const debugDir = join(stateDir, 'debug', runId);
  const logPath = join(debugDir, 'mcp-calls.jsonl');

  return {
    log(
      tool: string,
      input: Record<string, unknown>,
      result: Record<string, unknown>,
      durationMs: number
    ) {
      // Only log if debug dir exists (debug mode is enabled)
      if (!existsSync(debugDir)) return;

      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        tool,
        input,
        result,
        durationMs,
      });

      try {
        appendFileSync(logPath, `${entry}\n`);
      } catch {
        // Ignore write errors
      }
    },
    logError(tool: string, input: Record<string, unknown>, error: string, durationMs: number) {
      // Only log if debug dir exists (debug mode is enabled)
      if (!existsSync(debugDir)) return;

      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        tool,
        input,
        error,
        success: false,
        durationMs,
      });

      try {
        appendFileSync(logPath, `${entry}\n`);
      } catch {
        // Ignore write errors
      }
    },
  };
}

export function createMCPServer(runId: string, dbPath: string) {
  const mcpLogger = createMcpLogger(dbPath, runId);

  const server = new Server(
    { name: 'claude-squad', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'write_task',
        description: 'Create a new task for the current run',
        inputSchema: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Unique task identifier' },
            title: { type: 'string', description: 'Short task title' },
            description: { type: 'string', description: 'Detailed task description' },
            dependencies: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of tasks this depends on',
            },
            estimatedIterations: {
              type: 'number',
              description: 'Estimated iterations to complete',
            },
          },
          required: ['id', 'title', 'description'],
        },
      },
      {
        name: 'complete_task',
        description: 'Mark a task as completed',
        inputSchema: {
          type: 'object' as const,
          properties: {
            taskId: { type: 'string', description: 'ID of task to mark complete' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'fail_task',
        description: 'Mark a task as failed',
        inputSchema: {
          type: 'object' as const,
          properties: {
            taskId: { type: 'string', description: 'ID of task that failed' },
            reason: { type: 'string', description: 'Why the task failed' },
          },
          required: ['taskId', 'reason'],
        },
      },
      {
        name: 'add_plan_group',
        description: 'Add a parallel execution group to the plan',
        inputSchema: {
          type: 'object' as const,
          properties: {
            groupIndex: { type: 'number', description: 'Order of this group (0 = first)' },
            taskIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs that can run in parallel',
            },
          },
          required: ['groupIndex', 'taskIds'],
        },
      },
      {
        name: 'update_loop_status',
        description: 'Update the status of an execution loop',
        inputSchema: {
          type: 'object' as const,
          properties: {
            loopId: { type: 'string', description: 'Loop ID' },
            status: {
              type: 'string',
              enum: ['running', 'stuck', 'completed', 'failed'],
              description: 'New status',
            },
            error: { type: 'string', description: 'Error message if failed/stuck' },
          },
          required: ['loopId', 'status'],
        },
      },
      {
        name: 'record_cost',
        description: 'Record API cost for the run',
        inputSchema: {
          type: 'object' as const,
          properties: {
            costUsd: { type: 'number', description: 'Cost in USD' },
            loopId: { type: 'string', description: 'Loop ID if loop-specific' },
          },
          required: ['costUsd'],
        },
      },
      {
        name: 'create_loop',
        description: 'Create a new execution loop for parallel task processing',
        inputSchema: {
          type: 'object' as const,
          properties: {
            taskIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs to assign to this loop',
            },
            maxIterations: { type: 'number', description: 'Maximum iterations before stopping' },
            reviewInterval: { type: 'number', description: 'Iterations between reviews' },
            worktreePath: {
              type: 'string',
              description: 'Path to isolated worktree for this loop',
            },
            phase: { type: 'string', description: 'Phase that created this loop' },
          },
          required: ['taskIds', 'maxIterations', 'reviewInterval'],
        },
      },
      {
        name: 'persist_loop_state',
        description: 'Save iteration progress for an execution loop',
        inputSchema: {
          type: 'object' as const,
          properties: {
            loopId: { type: 'string', description: 'Loop ID' },
            iteration: { type: 'number', description: 'Current iteration count' },
            lastReviewAt: { type: 'number', description: 'Iteration when last reviewed' },
            sameErrorCount: { type: 'number', description: 'Consecutive same error count' },
            noProgressCount: { type: 'number', description: 'Consecutive no progress count' },
            lastError: { type: 'string', description: 'Last error message' },
            lastFileChangeIteration: {
              type: 'number',
              description: 'Iteration when files last changed',
            },
          },
          required: ['loopId', 'iteration'],
        },
      },
      {
        name: 'record_phase_cost',
        description: 'Record cost for a completed phase',
        inputSchema: {
          type: 'object' as const,
          properties: {
            phase: {
              type: 'string',
              enum: [
                'analyze',
                'enumerate',
                'plan',
                'build',
                'review',
                'revise',
                'conflict',
                'complete',
              ],
              description: 'Phase that incurred this cost',
            },
            costUsd: { type: 'number', description: 'Cost in USD' },
          },
          required: ['phase', 'costUsd'],
        },
      },
      {
        name: 'write_context',
        description:
          'Write context to the shared context store. Use for discoveries, errors, decisions, review issues, scratchpad entries, and codebase analysis.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            type: {
              type: 'string',
              enum: [
                'discovery',
                'error',
                'decision',
                'review_issue',
                'scratchpad',
                'codebase_analysis',
              ],
              description: 'The type of context being written',
            },
            content: {
              type: 'string',
              description:
                'The content. Plain string for simple types, JSON string for structured types',
            },
            task_id: { type: 'string', description: 'Associated task ID (optional)' },
            loop_id: { type: 'string', description: 'Associated loop ID (optional)' },
            file: { type: 'string', description: 'Associated file path (optional)' },
            line: { type: 'number', description: 'Associated line number (optional)' },
          },
          required: ['type', 'content'],
        },
      },
      {
        name: 'read_context',
        description:
          'Read context from the shared context store. Supports filtering by type, task, loop, file, and full-text search.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by context types (optional)',
            },
            task_id: { type: 'string', description: 'Filter by task ID (optional)' },
            loop_id: { type: 'string', description: 'Filter by loop ID (optional)' },
            file: { type: 'string', description: 'Filter by file path (optional)' },
            search: { type: 'string', description: 'Full-text search query (optional)' },
            limit: { type: 'number', description: 'Max entries to return (default: 500)' },
            offset: { type: 'number', description: 'Skip first N entries (default: 0)' },
            order: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort by created_at (default: desc)',
            },
          },
          required: [],
        },
      },
      {
        name: 'set_review_result',
        description:
          'Record the result of a run-level review. Use this after completing review of build work.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            interpretedIntent: {
              type: 'string',
              description: 'What the user was actually trying to accomplish',
            },
            intentSatisfied: {
              type: 'boolean',
              description: 'Does the implementation serve this intent?',
            },
            passed: { type: 'boolean', description: 'Whether the review passed' },
            issues: {
              type: 'array',
              description: 'List of issues found',
              items: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID this issue relates to' },
                  file: { type: 'string', description: 'File path where issue was found' },
                  line: { type: 'number', description: 'Line number of issue' },
                  type: {
                    type: 'string',
                    enum: [
                      'over-engineering',
                      'missing-error-handling',
                      'pattern-violation',
                      'dead-code',
                      'spec-intent-mismatch',
                    ],
                    description: 'Issue type',
                  },
                  description: { type: 'string', description: 'Description of the issue' },
                  suggestion: { type: 'string', description: 'How to fix the issue' },
                },
                required: ['file', 'type', 'description', 'suggestion'],
              },
            },
          },
          required: ['passed'],
        },
      },
      {
        name: 'set_loop_review_result',
        description:
          'Record the result of a per-loop review. Use this after reviewing work from a specific loop.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            loopId: { type: 'string', description: 'Loop ID being reviewed' },
            taskId: { type: 'string', description: 'Task ID being reviewed' },
            passed: { type: 'boolean', description: 'Whether the review passed' },
            interpretedIntent: {
              type: 'string',
              description: 'What the task was trying to accomplish',
            },
            intentSatisfied: {
              type: 'boolean',
              description: 'Does the implementation serve this intent?',
            },
            issues: {
              type: 'array',
              description: 'List of issues found',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string', description: 'File path where issue was found' },
                  line: { type: 'number', description: 'Line number of issue' },
                  type: {
                    type: 'string',
                    enum: [
                      'over-engineering',
                      'missing-error-handling',
                      'pattern-violation',
                      'dead-code',
                      'spec-intent-mismatch',
                    ],
                    description: 'Issue type',
                  },
                  description: { type: 'string', description: 'Description of the issue' },
                  suggestion: { type: 'string', description: 'How to fix the issue' },
                },
                required: ['file', 'type', 'description', 'suggestion'],
              },
            },
          },
          required: ['loopId', 'taskId', 'passed'],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const db = getDatabase();
    const startTime = Date.now();

    let result: { content: Array<{ type: string; text: string }> };

    try {
      switch (name) {
        case 'write_task': {
          const task = WriteTaskSchema.parse(args);
          db.prepare(`
          INSERT INTO tasks (id, run_id, title, description, dependencies, estimated_iterations)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            task.id,
            runId,
            task.title,
            task.description,
            JSON.stringify(task.dependencies),
            task.estimatedIterations
          );
          result = { content: [{ type: 'text', text: `Task ${task.id} created` }] };
          break;
        }

        case 'complete_task': {
          const { taskId } = CompleteTaskSchema.parse(args);
          db.prepare(`
          UPDATE tasks SET status = 'completed' WHERE id = ? AND run_id = ?
        `).run(taskId, runId);
          result = { content: [{ type: 'text', text: `Task ${taskId} completed` }] };
          break;
        }

        case 'fail_task': {
          const { taskId, reason } = FailTaskSchema.parse(args);
          db.prepare(`
          UPDATE tasks SET status = 'failed' WHERE id = ? AND run_id = ?
        `).run(taskId, runId);
          // Also log the failure as a context entry
          db.prepare(`
          INSERT INTO context (run_id, type, content)
          VALUES (?, 'error', ?)
        `).run(runId, `Task ${taskId} failed: ${reason}`);
          result = { content: [{ type: 'text', text: `Task ${taskId} marked as failed` }] };
          break;
        }

        case 'add_plan_group': {
          const group = AddPlanGroupSchema.parse(args);
          db.prepare(`
          INSERT INTO plan_groups (run_id, group_index, task_ids)
          VALUES (?, ?, ?)
        `).run(runId, group.groupIndex, JSON.stringify(group.taskIds));
          result = { content: [{ type: 'text', text: `Plan group ${group.groupIndex} added` }] };
          break;
        }

        case 'update_loop_status': {
          const update = UpdateLoopStatusSchema.parse(args);
          db.prepare(`
          UPDATE loops SET status = ?, last_error = ? WHERE id = ?
        `).run(update.status, update.error || null, update.loopId);
          result = { content: [{ type: 'text', text: `Loop ${update.loopId} updated` }] };
          break;
        }

        case 'record_cost': {
          const { costUsd, loopId, phase } = RecordCostSchema.parse(args);
          if (loopId) {
            db.prepare(`
            UPDATE loops SET cost_usd = cost_usd + ? WHERE id = ?
          `).run(costUsd, loopId);
          }
          db.prepare(`
          UPDATE runs SET total_cost_usd = total_cost_usd + ? WHERE id = ?
        `).run(costUsd, runId);
          // Track phase costs with upsert
          db.prepare(`
          INSERT INTO phase_costs (run_id, phase, cost_usd)
          VALUES (?, ?, ?)
          ON CONFLICT(run_id, phase) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd
        `).run(runId, phase, costUsd);
          result = {
            content: [{ type: 'text', text: `Cost $${costUsd} recorded for phase ${phase}` }],
          };
          break;
        }

        case 'create_loop': {
          const loop = CreateLoopSchema.parse(args);
          const loopId = crypto.randomUUID();
          db.prepare(`
          INSERT INTO loops (id, run_id, task_ids, max_iterations, review_interval, worktree_path, phase)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            loopId,
            runId,
            JSON.stringify(loop.taskIds),
            loop.maxIterations,
            loop.reviewInterval,
            loop.worktreePath ?? null,
            loop.phase
          );
          // Update task assignments
          for (const taskId of loop.taskIds) {
            db.prepare(`
            UPDATE tasks SET assigned_loop_id = ? WHERE id = ? AND run_id = ?
          `).run(loopId, taskId, runId);
          }
          result = {
            content: [
              { type: 'text', text: `Loop ${loopId} created with ${loop.taskIds.length} tasks` },
            ],
          };
          break;
        }

        case 'persist_loop_state': {
          const state = PersistLoopStateSchema.parse(args);
          db.prepare(`
          UPDATE loops SET
            iteration = ?,
            last_review_at = COALESCE(?, last_review_at),
            same_error_count = COALESCE(?, same_error_count),
            no_progress_count = COALESCE(?, no_progress_count),
            last_error = COALESCE(?, last_error),
            last_file_change_iteration = COALESCE(?, last_file_change_iteration)
          WHERE id = ?
        `).run(
            state.iteration,
            state.lastReviewAt ?? null,
            state.sameErrorCount ?? null,
            state.noProgressCount ?? null,
            state.lastError ?? null,
            state.lastFileChangeIteration ?? null,
            state.loopId
          );
          result = {
            content: [
              {
                type: 'text',
                text: `Loop ${state.loopId} state persisted at iteration ${state.iteration}`,
              },
            ],
          };
          break;
        }

        case 'record_phase_cost': {
          const { phase, costUsd } = RecordPhaseCostSchema.parse(args);
          // Update total run cost
          db.prepare(`
          UPDATE runs SET total_cost_usd = total_cost_usd + ? WHERE id = ?
        `).run(costUsd, runId);
          // Upsert phase cost
          db.prepare(`
          INSERT INTO phase_costs (run_id, phase, cost_usd)
          VALUES (?, ?, ?)
          ON CONFLICT(run_id, phase) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd
        `).run(runId, phase, costUsd);
          result = {
            content: [{ type: 'text', text: `Phase ${phase} cost $${costUsd} recorded` }],
          };
          break;
        }

        case 'write_context': {
          const ctx = WriteContextSchema.parse(args);
          const { id } = writeContextToDb(db, {
            runId,
            type: ctx.type,
            content: ctx.content,
            taskId: ctx.task_id,
            loopId: ctx.loop_id,
            file: ctx.file,
            line: ctx.line,
          });
          result = {
            content: [{ type: 'text', text: `Context written (id: ${id}, type: ${ctx.type})` }],
          };
          break;
        }

        case 'read_context': {
          const opts = ReadContextSchema.parse(args);
          const { entries, total } = readContextFromDb(db, {
            runId,
            types: opts.types,
            taskId: opts.task_id,
            loopId: opts.loop_id,
            file: opts.file,
            search: opts.search,
            limit: opts.limit,
            offset: opts.offset,
            order: opts.order,
          });
          result = { content: [{ type: 'text', text: JSON.stringify({ entries, total }) }] };
          break;
        }

        case 'set_review_result': {
          const review = SetReviewResultSchema.parse(args);

          // Use transaction to ensure atomicity of delete + inserts + update
          const saveReviewResult = db.transaction(() => {
            // Clear previous run-level review issues from unified context table
            db.prepare(
              `DELETE FROM context WHERE run_id = ? AND type = 'review_issue' AND loop_id IS NULL`
            ).run(runId);

            // Store structured review issues in unified context table
            const insertStmt = db.prepare(`
            INSERT INTO context (run_id, type, content, task_id, file, line)
            VALUES (?, 'review_issue', ?, ?, ?, ?)
          `);
            for (const issue of review.issues) {
              insertStmt.run(
                runId,
                JSON.stringify({
                  issue_type: issue.type,
                  description: issue.description,
                  suggestion: issue.suggestion,
                }),
                issue.taskId ?? null,
                issue.file,
                issue.line ?? null
              );
            }

            // Update runs table for intent analysis
            db.prepare(`
            UPDATE runs SET pending_review = 0, interpreted_intent = ?, intent_satisfied = ?
            WHERE id = ?
          `).run(review.interpretedIntent ?? null, review.intentSatisfied ? 1 : 0, runId);
          });

          saveReviewResult();

          result = {
            content: [
              {
                type: 'text',
                text: `Review result recorded (passed: ${review.passed}, issues: ${review.issues.length})`,
              },
            ],
          };
          break;
        }

        case 'set_loop_review_result': {
          const review = SetLoopReviewResultSchema.parse(args);

          // Validate loopId exists - provide clear error if not
          const loopExists = db
            .prepare('SELECT id FROM loops WHERE id = ? AND run_id = ?')
            .get(review.loopId, runId) as { id: string } | undefined;

          if (!loopExists) {
            // List available loops to help the agent
            const availableLoops = db
              .prepare('SELECT id, task_ids FROM loops WHERE run_id = ?')
              .all(runId) as Array<{ id: string; task_ids: string }>;

            const loopList = availableLoops
              .map((l) => `  - ${l.id} (tasks: ${l.task_ids})`)
              .join('\n');

            throw new Error(
              `Loop '${review.loopId}' not found. Available loops for this run:\n${loopList || '  (no loops found)'}\n\nUse the exact loopId from the prompt example.`
            );
          }

          // Validate taskId exists - provide clear error if not
          const taskExists = db
            .prepare('SELECT id FROM tasks WHERE id = ? AND run_id = ?')
            .get(review.taskId, runId) as { id: string } | undefined;

          if (!taskExists) {
            // List available tasks to help the agent
            const availableTasks = db
              .prepare('SELECT id, title FROM tasks WHERE run_id = ?')
              .all(runId) as Array<{ id: string; title: string }>;

            const taskList = availableTasks.map((t) => `  - ${t.id}: ${t.title}`).join('\n');

            throw new Error(
              `Task '${review.taskId}' not found. Available tasks for this run:\n${taskList || '  (no tasks found)'}\n\nUse the exact taskId from the prompt example (e.g., "task-0", "task-1").`
            );
          }

          // Use transaction to ensure atomicity of loop_reviews insert + context inserts
          const reviewId = crypto.randomUUID();
          const saveLoopReviewResult = db.transaction(() => {
            // Create a new loop review record
            db.prepare(`
            INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed, interpreted_intent, intent_satisfied)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
              reviewId,
              runId,
              review.loopId,
              review.taskId,
              review.passed ? 1 : 0,
              review.interpretedIntent ?? null,
              review.intentSatisfied != null ? (review.intentSatisfied ? 1 : 0) : null
            );

            // Store review issues in unified context table with loop_id
            const insertStmt = db.prepare(`
            INSERT INTO context (run_id, type, content, task_id, loop_id, file, line)
            VALUES (?, 'review_issue', ?, ?, ?, ?, ?)
          `);
            for (const issue of review.issues) {
              insertStmt.run(
                runId,
                JSON.stringify({
                  issue_type: issue.type,
                  description: issue.description,
                  suggestion: issue.suggestion,
                  loop_review_id: reviewId,
                }),
                review.taskId,
                review.loopId,
                issue.file,
                issue.line ?? null
              );
            }
          });

          saveLoopReviewResult();

          result = {
            content: [
              {
                type: 'text',
                text: `Loop review result recorded (loopId: ${review.loopId}, passed: ${review.passed}, issues: ${review.issues.length})`,
              },
            ],
          };
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      const durationMs = Date.now() - startTime;
      mcpLogger.log(name, args as Record<string, unknown>, { success: true }, durationMs);

      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      mcpLogger.logError(name, args as Record<string, unknown>, errorMessage, durationMs);

      // Return error as tool result instead of throwing
      // This gives the agent a clear error message to work with
      return {
        content: [
          {
            type: 'text',
            text: `Error in ${name}: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMCPServer(runId: string, dbPath: string) {
  const server = createMCPServer(runId, dbPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
