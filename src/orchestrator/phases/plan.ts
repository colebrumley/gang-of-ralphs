import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PLAN_PROMPT, SCAFFOLD_SECTION_PLAN } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import type { OrchestratorState, Task, TaskGraph } from '../../types/index.js';
import {
  type StreamEvent,
  isResultMessage,
  isStreamEventMessage,
  isToolProgressMessage,
} from '../../types/index.js';
// Note: We no longer import isEmptyProject here - we use state.wasEmptyProject
// which was set during ENUMERATE phase to avoid race conditions

/**
 * Load plan groups from database after agent has written them via MCP tools.
 */
export function loadPlanGroupsFromDB(runId: string): string[][] {
  const db = getDatabase();
  const planGroupRows = db
    .prepare('SELECT * FROM plan_groups WHERE run_id = ? ORDER BY group_index')
    .all(runId) as Array<{ task_ids: string }>;

  return planGroupRows.map((row) => JSON.parse(row.task_ids) as string[]);
}

export function buildTaskGraph(tasks: Task[], parallelGroups: string[][]): TaskGraph {
  return {
    tasks,
    parallelGroups,
  };
}

export interface PlanResult {
  taskGraph: TaskGraph;
  costUsd: number;
}

export async function executePlan(
  state: OrchestratorState,
  onOutput?: (text: string) => void,
  tracer?: DebugTracer
): Promise<PlanResult> {
  const dbPath = join(state.stateDir, 'state.db');
  const cwd = process.cwd();
  const effortConfig = getEffortConfig(state.effort);
  const model = getModelId(effortConfig.models.plan);
  const config = createAgentConfig('plan', cwd, state.runId, dbPath, model);

  // Use persisted wasEmptyProject from ENUMERATE phase to avoid race conditions
  // where files created by ENUMERATE would make isEmptyProject() return false here
  const isEmpty = state.wasEmptyProject ?? false;
  const scaffoldSection = isEmpty ? SCAFFOLD_SECTION_PLAN : '';
  const basePrompt = PLAN_PROMPT.replace('{{SCAFFOLD_PLAN_SECTION}}', scaffoldSection);

  const tasksJson = JSON.stringify(state.tasks, null, 2);
  const prompt = `${basePrompt}

## Tasks to Plan:
${tasksJson}`;

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  const writer = tracer?.startAgentCall({
    phase: 'plan',
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

  // Plan groups are now in the database via MCP add_plan_group calls
  const parallelGroups = loadPlanGroupsFromDB(state.runId);

  return {
    taskGraph: buildTaskGraph(state.tasks, parallelGroups),
    costUsd,
  };
}
