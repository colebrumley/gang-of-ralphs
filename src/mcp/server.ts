import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDatabase } from '../db/index.js';
import {
  AddContextSchema,
  AddPlanGroupSchema,
  CompleteTaskSchema,
  CreateLoopSchema,
  FailTaskSchema,
  PersistLoopStateSchema,
  RecordCostSchema,
  RecordPhaseCostSchema,
  SetCodebaseAnalysisSchema,
  SetLoopReviewResultSchema,
  SetReviewResultSchema,
  UpdateLoopStatusSchema,
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
        name: 'add_context',
        description: 'Add a discovery, error, or decision to context',
        inputSchema: {
          type: 'object' as const,
          properties: {
            type: {
              type: 'string',
              enum: ['discovery', 'error', 'decision'],
              description: 'Type of context entry',
            },
            content: { type: 'string', description: 'The context content' },
          },
          required: ['type', 'content'],
        },
      },
      {
        name: 'set_review_result',
        description: 'Record the result of a review phase',
        inputSchema: {
          type: 'object' as const,
          properties: {
            interpretedIntent: {
              type: 'string',
              description:
                'In 1-2 sentences, what was the user actually trying to accomplish? What unstated expectations would be reasonable?',
            },
            intentSatisfied: {
              type: 'boolean',
              description:
                'Does the implementation serve the interpreted intent, not just the literal spec words?',
            },
            passed: { type: 'boolean', description: 'Whether review passed' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'ID of the task with the issue' },
                  file: { type: 'string', description: 'File path where the issue was found' },
                  line: { type: 'number', description: 'Line number of the issue' },
                  type: {
                    type: 'string',
                    enum: [
                      'over-engineering',
                      'missing-error-handling',
                      'pattern-violation',
                      'dead-code',
                      'spec-intent-mismatch',
                    ],
                    description: 'Type of issue',
                  },
                  description: { type: 'string', description: 'Description of the issue' },
                  suggestion: { type: 'string', description: 'Suggested fix' },
                },
                required: ['taskId', 'file', 'type', 'description', 'suggestion'],
              },
              description: 'Structured review issues found',
            },
          },
          required: ['interpretedIntent', 'intentSatisfied', 'passed'],
        },
      },
      {
        name: 'set_loop_review_result',
        description: 'Report review results for a specific loop',
        inputSchema: {
          type: 'object' as const,
          properties: {
            loopId: { type: 'string', description: 'The loop being reviewed' },
            taskId: {
              type: 'string',
              description: 'The task that was reviewed (optional for checkpoint reviews)',
            },
            passed: { type: 'boolean', description: 'Whether review passed' },
            interpretedIntent: {
              type: 'string',
              description: 'What the task was really trying to accomplish',
            },
            intentSatisfied: {
              type: 'boolean',
              description: 'Does the implementation serve the interpreted intent?',
            },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string', description: 'File path where the issue was found' },
                  line: { type: 'number', description: 'Line number of the issue' },
                  type: {
                    type: 'string',
                    enum: [
                      'over-engineering',
                      'missing-error-handling',
                      'pattern-violation',
                      'dead-code',
                      'spec-intent-mismatch',
                    ],
                    description: 'Type of issue',
                  },
                  description: { type: 'string', description: 'Description of the issue' },
                  suggestion: { type: 'string', description: 'Suggested fix' },
                },
                required: ['file', 'type', 'description', 'suggestion'],
              },
              description: 'Structured review issues found',
            },
          },
          required: ['loopId', 'passed'],
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
              enum: ['enumerate', 'plan', 'build', 'review', 'revise', 'conflict', 'complete'],
              description: 'Phase that incurred this cost',
            },
            costUsd: { type: 'number', description: 'Cost in USD' },
          },
          required: ['phase', 'costUsd'],
        },
      },
      {
        name: 'set_codebase_analysis',
        description: 'Store the codebase analysis results from the analyze phase',
        inputSchema: {
          type: 'object' as const,
          properties: {
            projectType: {
              type: 'string',
              description: 'Type of project (e.g., "TypeScript Node.js CLI")',
            },
            techStack: {
              type: 'array',
              items: { type: 'string' },
              description: 'Technologies/frameworks used',
            },
            directoryStructure: {
              type: 'string',
              description: 'Brief description of code organization',
            },
            existingFeatures: {
              type: 'array',
              items: { type: 'string' },
              description: 'Features the codebase already implements',
            },
            entryPoints: {
              type: 'array',
              items: { type: 'string' },
              description: 'Main entry point files',
            },
            patterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Key patterns and conventions observed',
            },
            summary: {
              type: 'string',
              description: '2-3 sentence summary of what the codebase does',
            },
          },
          required: [
            'projectType',
            'techStack',
            'directoryStructure',
            'existingFeatures',
            'entryPoints',
            'patterns',
            'summary',
          ],
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
          INSERT INTO context_entries (run_id, entry_type, content)
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

      case 'add_context': {
        const ctx = AddContextSchema.parse(args);
        db.prepare(`
          INSERT INTO context_entries (run_id, entry_type, content)
          VALUES (?, ?, ?)
        `).run(runId, ctx.type, ctx.content);
        result = { content: [{ type: 'text', text: `Context ${ctx.type} added` }] };
        break;
      }

      case 'set_review_result': {
        const review = SetReviewResultSchema.parse(args);
        // Clear previous review issues for this run (only run-level reviews, not loop reviews)
        db.prepare(`
          DELETE FROM review_issues WHERE run_id = ? AND loop_id IS NULL
        `).run(runId);
        // Store structured review issues
        for (const issue of review.issues) {
          db.prepare(`
            INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            runId,
            issue.taskId,
            issue.file,
            issue.line ?? null,
            issue.type,
            issue.description,
            issue.suggestion
          );
        }
        // Update pending_review and store intent analysis on runs
        db.prepare(`
          UPDATE runs SET
            pending_review = 0,
            interpreted_intent = ?,
            intent_satisfied = ?
          WHERE id = ?
        `).run(review.interpretedIntent, review.intentSatisfied ? 1 : 0, runId);

        // Determine final pass/fail: must pass both technical review AND intent check
        const finalPassed = review.passed && review.intentSatisfied;
        result = {
          content: [
            {
              type: 'text',
              text: `Review result: ${finalPassed ? 'PASSED' : 'FAILED'} (${review.issues.length} issues, intent ${review.intentSatisfied ? 'satisfied' : 'NOT satisfied'})`,
            },
          ],
        };
        break;
      }

      case 'set_loop_review_result': {
        const review = SetLoopReviewResultSchema.parse(args);
        const reviewId = crypto.randomUUID();

        // Insert the loop review record
        db.prepare(`
          INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed, interpreted_intent, intent_satisfied, cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          reviewId,
          runId,
          review.loopId,
          review.taskId ?? null,
          review.passed ? 1 : 0,
          review.interpretedIntent ?? null,
          review.intentSatisfied != null ? (review.intentSatisfied ? 1 : 0) : null
        );

        // Store structured review issues with loop context
        for (const issue of review.issues) {
          db.prepare(`
            INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion, loop_id, loop_review_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            runId,
            review.taskId ?? 'checkpoint',
            issue.file,
            issue.line ?? null,
            issue.type,
            issue.description,
            issue.suggestion,
            review.loopId,
            reviewId
          );
        }

        const intentStatus =
          review.intentSatisfied != null
            ? review.intentSatisfied
              ? 'satisfied'
              : 'NOT satisfied'
            : 'not evaluated';
        result = {
          content: [
            {
              type: 'text',
              text: `Loop review ${reviewId}: ${review.passed ? 'PASSED' : 'FAILED'} (${review.issues.length} issues, intent ${intentStatus})`,
            },
          ],
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
        result = { content: [{ type: 'text', text: `Phase ${phase} cost $${costUsd} recorded` }] };
        break;
      }

      case 'set_codebase_analysis': {
        const analysis = SetCodebaseAnalysisSchema.parse(args);
        db.prepare(`
          UPDATE runs SET codebase_analysis = ? WHERE id = ?
        `).run(JSON.stringify(analysis), runId);
        result = {
          content: [{ type: 'text', text: `Codebase analysis stored: ${analysis.projectType}` }],
        };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    const durationMs = Date.now() - startTime;
    mcpLogger.log(name, args as Record<string, unknown>, { success: true }, durationMs);

    return result;
  });

  return server;
}

export async function startMCPServer(runId: string, dbPath: string) {
  const server = createMCPServer(runId, dbPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
