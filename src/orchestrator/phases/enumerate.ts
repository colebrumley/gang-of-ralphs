import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  CODEBASE_ANALYSIS_SECTION,
  EMPTY_PROJECT_ANALYSIS,
  ENUMERATE_PROMPT,
  SCAFFOLD_SECTION_ENUMERATE,
} from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import type { CodebaseAnalysis, OrchestratorState, Task } from '../../types/index.js';
import {
  type StreamEvent,
  isResultMessage,
  isStreamEventMessage,
  isToolProgressMessage,
} from '../../types/index.js';

// Task granularity bounds (Risk #5 mitigation)
const MIN_ESTIMATED_ITERATIONS = 3;
const MAX_ESTIMATED_ITERATIONS = 25;

/**
 * Format codebase analysis for injection into ENUMERATE_PROMPT.
 */
export function formatCodebaseAnalysis(analysis: CodebaseAnalysis | null): string {
  if (!analysis) {
    return EMPTY_PROJECT_ANALYSIS;
  }

  if (analysis.projectType === 'empty/greenfield') {
    return EMPTY_PROJECT_ANALYSIS;
  }

  return CODEBASE_ANALYSIS_SECTION.replace('{{projectType}}', analysis.projectType)
    .replace('{{techStack}}', analysis.techStack.join(', ') || 'None detected')
    .replace('{{directoryStructure}}', analysis.directoryStructure)
    .replace(
      '{{existingFeatures}}',
      analysis.existingFeatures.length > 0
        ? analysis.existingFeatures.map((f) => `- ${f}`).join('\n')
        : '- None'
    )
    .replace('{{entryPoints}}', analysis.entryPoints.join(', ') || 'None detected')
    .replace(
      '{{patterns}}',
      analysis.patterns.length > 0
        ? analysis.patterns.map((p) => `- ${p}`).join('\n')
        : '- None detected'
    )
    .replace('{{summary}}', analysis.summary);
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
  wasEmptyProject: boolean;
}

/**
 * Error thrown when the enumerate phase agent fails to signal completion.
 */
export class EnumerateIncompleteError extends Error {
  constructor(
    public readonly taskCount: number,
    public readonly output: string
  ) {
    super(
      `Enumerate phase did not signal ENUMERATE_COMPLETE. Agent may have crashed, timed out, or failed. Found ${taskCount} partial tasks. Last output: "${output.slice(-200)}"`
    );
    this.name = 'EnumerateIncompleteError';
  }
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

  // Use wasEmptyProject from ANALYZE phase (should always be set by now)
  const isEmpty = state.wasEmptyProject ?? false;
  const scaffoldSection = isEmpty ? SCAFFOLD_SECTION_ENUMERATE : '';

  // Inject codebase analysis from ANALYZE phase
  const codebaseAnalysisSection = formatCodebaseAnalysis(state.codebaseAnalysis);
  const basePrompt = ENUMERATE_PROMPT.replace('{{SCAFFOLD_SECTION}}', scaffoldSection).replace(
    '{{CODEBASE_ANALYSIS}}',
    codebaseAnalysisSection
  );

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
    if (isToolProgressMessage(message)) {
      const toolName = message.tool_name || 'tool';
      const elapsed = message.elapsed_time_seconds || 0;
      const progressText = `[tool] ${toolName} (${elapsed.toFixed(1)}s)\n`;
      writer?.appendOutput(progressText);
      onOutput?.(progressText);
    }
    // Handle streaming events for real-time thinking output
    if (isStreamEventMessage(message)) {
      const event = message.event as StreamEvent;
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
    if (isResultMessage(message)) {
      costUsd = message.total_cost_usd || 0;
    }
  }

  const durationMs = Date.now() - startTime;
  await writer?.complete(costUsd, durationMs);

  // Tasks are now in the database via MCP write_task calls
  const tasks = loadTasksFromDB(state.runId);

  // Validate that the agent signaled completion (Risk #4 mitigation)
  // If the agent crashed, timed out, or failed without signaling,
  // we should not proceed with partial data
  if (!fullOutput.includes('ENUMERATE_COMPLETE')) {
    throw new EnumerateIncompleteError(tasks.length, fullOutput);
  }

  return {
    tasks,
    costUsd,
    wasEmptyProject: isEmpty,
  };
}
