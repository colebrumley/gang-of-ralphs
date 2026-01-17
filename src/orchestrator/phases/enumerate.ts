import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ENUMERATE_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import type { OrchestratorState, Task } from '../../types/index.js';

// Task granularity bounds (Risk #5 mitigation)
const MIN_ESTIMATED_ITERATIONS = 3;
const MAX_ESTIMATED_ITERATIONS = 25;

export interface GranularityValidation {
  valid: boolean;
  warnings: string[];
}

/**
 * Validate that tasks are appropriately sized.
 * Too small = overhead dominates, too large = never completes.
 */
export function validateTaskGranularity(tasks: Task[]): GranularityValidation {
  const warnings: string[] = [];

  for (const task of tasks) {
    if (task.estimatedIterations < MIN_ESTIMATED_ITERATIONS) {
      warnings.push(
        `Task "${task.title}" (${task.id}) may be too small ` +
          `(${task.estimatedIterations} iterations). Consider combining with related tasks.`
      );
    }
    if (task.estimatedIterations > MAX_ESTIMATED_ITERATIONS) {
      warnings.push(
        `Task "${task.title}" (${task.id}) may be too large ` +
          `(${task.estimatedIterations} iterations). Consider breaking into subtasks.`
      );
    }
    if (task.description.length < 20) {
      warnings.push(
        `Task "${task.title}" (${task.id}) has a short description. More detail helps the build agent.`
      );
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

/**
 * Load tasks from database after agent has written them via MCP tools.
 */
export function loadTasksFromDB(runId: string): Task[] {
  const db = getDatabase();
  const taskRows = db.prepare('SELECT * FROM tasks WHERE run_id = ?').all(runId) as Array<{
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    dependencies: string;
    estimated_iterations: number;
    assigned_loop_id: string | null;
  }>;

  return taskRows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    dependencies: JSON.parse(row.dependencies),
    estimatedIterations: row.estimated_iterations,
    assignedLoopId: row.assigned_loop_id,
  }));
}

export interface EnumerateResult {
  tasks: Task[];
  costUsd: number;
}

export async function executeEnumerate(
  state: OrchestratorState,
  onOutput?: (text: string) => void,
  tracer?: DebugTracer
): Promise<EnumerateResult> {
  const specContent = await readFile(state.specPath, 'utf-8');
  const dbPath = join(state.stateDir, 'state.db');
  const config = createAgentConfig('enumerate', process.cwd(), state.runId, dbPath);
  const cwd = process.cwd();

  const prompt = `${ENUMERATE_PROMPT}

## Spec File Content:
${specContent}`;

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      mcpServers: {
        'sq-db': {
          command: 'node',
          args: [resolve(cwd, 'node_modules/.bin/sq-mcp'), state.runId, dbPath],
        },
      },
    },
  })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block) {
          fullOutput += block.text;
          onOutput?.(block.text);
        }
      }
    }
    if (message.type === 'result') {
      costUsd = (message as any).total_cost_usd || 0;
    }
  }

  const durationMs = Date.now() - startTime;

  await tracer?.logAgentCall({
    phase: 'enumerate',
    prompt,
    response: fullOutput,
    costUsd,
    durationMs,
  });

  // Tasks are now in the database via MCP write_task calls
  const tasks = loadTasksFromDB(state.runId);

  return {
    tasks,
    costUsd,
  };
}
