import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ENUMERATE_PROMPT, SCAFFOLD_SECTION_ENUMERATE } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import type { OrchestratorState, Task } from '../../types/index.js';

// Task granularity bounds (Risk #5 mitigation)
const MIN_ESTIMATED_ITERATIONS = 3;
const MAX_ESTIMATED_ITERATIONS = 25;

// Files/directories to ignore when checking if a project is empty
const IGNORED_ENTRIES = new Set([
  '.git',
  '.sq',
  '.gitignore',
  '.gitkeep',
  'node_modules',
  '.DS_Store',
]);

/**
 * Check if a directory is effectively empty (new project).
 * Returns true if directory contains only ignored files/dirs or spec files.
 */
export async function isEmptyProject(dir: string, specPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    const significantEntries = entries.filter((entry) => {
      // Ignore common non-project files
      if (IGNORED_ENTRIES.has(entry)) return false;
      // Ignore the spec file itself
      if (specPath.endsWith(entry)) return false;
      // Ignore markdown files (often just specs/docs)
      if (entry.endsWith('.md')) return false;
      return true;
    });
    return significantEntries.length === 0;
  } catch {
    // If we can't read the directory, assume it's not empty
    return false;
  }
}

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
  const effortConfig = getEffortConfig(state.effort);
  const model = getModelId(effortConfig.models.enumerate);
  const config = createAgentConfig('enumerate', process.cwd(), state.runId, dbPath, model);
  const cwd = process.cwd();

  // Only include scaffolding instructions for empty/new projects
  const isEmpty = await isEmptyProject(cwd, state.specPath);
  const scaffoldSection = isEmpty ? SCAFFOLD_SECTION_ENUMERATE : '';
  const basePrompt = ENUMERATE_PROMPT.replace('{{SCAFFOLD_SECTION}}', scaffoldSection);

  const prompt = `${basePrompt}

## Spec File Content:
${specContent}`;

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  const writer = tracer?.startAgentCall({
    phase: 'enumerate',
    prompt,
  });

  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      model: config.model,
      includePartialMessages: true,
      mcpServers: {
        'sq-db': {
          command: 'node',
          args: [MCP_SERVER_PATH, state.runId, dbPath],
        },
      },
    },
  })) {
    // Handle tool progress messages to show activity during tool execution
    if (message.type === 'tool_progress') {
      const toolName = (message as any).tool_name || 'tool';
      const elapsed = (message as any).elapsed_time_seconds || 0;
      const progressText = `[tool] ${toolName} (${elapsed.toFixed(1)}s)\n`;
      writer?.appendOutput(progressText);
      onOutput?.(progressText);
    }
    // Handle streaming events for real-time thinking output
    if (message.type === 'stream_event') {
      const event = message.event as any;
      // Handle tool_use content block start to show when a tool begins
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const toolName = event.content_block.name || 'tool';
        const toolText = `[tool] starting ${toolName}\n`;
        writer?.appendOutput(toolText);
        onOutput?.(toolText);
      }
      // Handle thinking delta events
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const thinkingText = event.delta.thinking || '';
        if (thinkingText) {
          writer?.appendOutput(thinkingText);
          onOutput?.(`[thinking] ${thinkingText}`);
        }
      }
      // Handle text delta events
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const textDelta = event.delta.text || '';
        if (textDelta) {
          fullOutput += textDelta;
          writer?.appendOutput(textDelta);
          onOutput?.(textDelta);
        }
      }
    }
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        // Only handle text blocks that weren't already streamed
        if ('text' in block && !fullOutput.includes(block.text)) {
          fullOutput += block.text;
          writer?.appendOutput(block.text);
          onOutput?.(block.text);
        }
        // Capture thinking blocks to show activity during extended thinking
        if (
          'type' in block &&
          block.type === 'thinking' &&
          'thinking' in block &&
          typeof block.thinking === 'string'
        ) {
          const thinkingText = `[thinking] ${block.thinking}\n`;
          writer?.appendOutput(thinkingText);
          onOutput?.(thinkingText);
        }
      }
    }
    if (message.type === 'result') {
      costUsd = (message as any).total_cost_usd || 0;
    }
  }

  const durationMs = Date.now() - startTime;
  await writer?.complete(costUsd, durationMs);

  // Tasks are now in the database via MCP write_task calls
  const tasks = loadTasksFromDB(state.runId);

  return {
    tasks,
    costUsd,
  };
}
