import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getDatabase } from '../db/index.js';
import {
  WriteTaskSchema,
  CompleteTaskSchema,
  FailTaskSchema,
  AddPlanGroupSchema,
  UpdateLoopStatusSchema,
  RecordCostSchema,
  AddContextSchema,
  SetReviewResultSchema,
} from './tools.js';

export function createMCPServer(runId: string) {
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
            dependencies: { type: 'array', items: { type: 'string' }, description: 'IDs of tasks this depends on' },
            estimatedIterations: { type: 'number', description: 'Estimated iterations to complete' },
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
            taskIds: { type: 'array', items: { type: 'string' }, description: 'Task IDs that can run in parallel' },
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
            status: { type: 'string', enum: ['running', 'stuck', 'completed', 'failed'], description: 'New status' },
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
            type: { type: 'string', enum: ['discovery', 'error', 'decision'], description: 'Type of context entry' },
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
                    enum: ['over-engineering', 'missing-error-handling', 'pattern-violation', 'dead-code'],
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
          required: ['passed'],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const db = getDatabase();

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
        return { content: [{ type: 'text', text: `Task ${task.id} created` }] };
      }

      case 'complete_task': {
        const { taskId } = CompleteTaskSchema.parse(args);
        db.prepare(`
          UPDATE tasks SET status = 'completed' WHERE id = ? AND run_id = ?
        `).run(taskId, runId);
        return { content: [{ type: 'text', text: `Task ${taskId} completed` }] };
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
        return { content: [{ type: 'text', text: `Task ${taskId} marked as failed` }] };
      }

      case 'add_plan_group': {
        const group = AddPlanGroupSchema.parse(args);
        db.prepare(`
          INSERT INTO plan_groups (run_id, group_index, task_ids)
          VALUES (?, ?, ?)
        `).run(runId, group.groupIndex, JSON.stringify(group.taskIds));
        return { content: [{ type: 'text', text: `Plan group ${group.groupIndex} added` }] };
      }

      case 'update_loop_status': {
        const update = UpdateLoopStatusSchema.parse(args);
        db.prepare(`
          UPDATE loops SET status = ?, last_error = ? WHERE id = ?
        `).run(update.status, update.error || null, update.loopId);
        return { content: [{ type: 'text', text: `Loop ${update.loopId} updated` }] };
      }

      case 'record_cost': {
        const { costUsd, loopId } = RecordCostSchema.parse(args);
        if (loopId) {
          db.prepare(`
            UPDATE loops SET cost_usd = cost_usd + ? WHERE id = ?
          `).run(costUsd, loopId);
        }
        db.prepare(`
          UPDATE runs SET total_cost_usd = total_cost_usd + ? WHERE id = ?
        `).run(costUsd, runId);
        return { content: [{ type: 'text', text: `Cost $${costUsd} recorded` }] };
      }

      case 'add_context': {
        const ctx = AddContextSchema.parse(args);
        db.prepare(`
          INSERT INTO context_entries (run_id, entry_type, content)
          VALUES (?, ?, ?)
        `).run(runId, ctx.type, ctx.content);
        return { content: [{ type: 'text', text: `Context ${ctx.type} added` }] };
      }

      case 'set_review_result': {
        const review = SetReviewResultSchema.parse(args);
        // Clear previous review issues for this run
        db.prepare(`
          DELETE FROM review_issues WHERE run_id = ?
        `).run(runId);
        // Store structured review issues
        for (const issue of review.issues) {
          db.prepare(`
            INSERT INTO review_issues (run_id, task_id, file, line, type, description, suggestion)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(runId, issue.taskId, issue.file, issue.line ?? null, issue.type, issue.description, issue.suggestion);
        }
        // Update pending_review on runs
        db.prepare(`
          UPDATE runs SET pending_review = 0 WHERE id = ?
        `).run(runId);
        return { content: [{ type: 'text', text: `Review result: ${review.passed ? 'PASSED' : 'FAILED'} (${review.issues.length} issues)` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

export async function startMCPServer(runId: string) {
  const server = createMCPServer(runId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
