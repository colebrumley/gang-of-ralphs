import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PLAN_PROMPT, SCAFFOLD_SECTION_PLAN } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import { formatToolInput, formatToolOutput } from '../../tui/tool-formatting.js';
import type { OrchestratorState, Task, TaskGraph } from '../../types/index.js';
import {
  type StreamEvent,
  extractInputJsonDelta,
  extractToolUseStart,
  isContentBlockStop,
  isInputJsonDelta,
  isResultMessage,
  isStreamEventMessage,
  isToolUseStart,
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

/**
 * Error thrown when the plan phase agent fails to signal completion.
 */
export class PlanIncompleteError extends Error {
  constructor(
    public readonly groupCount: number,
    public readonly output: string
  ) {
    super(
      `Plan phase did not signal PLAN_COMPLETE. Agent may have crashed, timed out, or failed. Found ${groupCount} partial plan groups. Last output: "${output.slice(-200)}"`
    );
    this.name = 'PlanIncompleteError';
  }
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

  // Pending tool calls map: index -> tool info with accumulated input JSON
  const pendingToolCalls = new Map<number, { name: string; toolId: string; inputJson: string }>();
  // Completed tool calls map: toolId -> tool info with parsed input (for result formatting)
  const completedToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

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
    // Handle streaming events for real-time tool output and thinking
    if (isStreamEventMessage(message)) {
      const event = message.event as StreamEvent;

      // Handle tool_use content block start - store in pending map
      if (isToolUseStart(event)) {
        const toolInfo = extractToolUseStart(event);
        if (toolInfo) {
          pendingToolCalls.set(toolInfo.index, {
            name: toolInfo.toolName,
            toolId: toolInfo.toolId,
            inputJson: '',
          });
        }
      }

      // Handle input_json_delta - accumulate JSON in pending map
      if (isInputJsonDelta(event)) {
        const deltaInfo = extractInputJsonDelta(event);
        if (deltaInfo) {
          const pending = pendingToolCalls.get(deltaInfo.index);
          if (pending) {
            pending.inputJson += deltaInfo.partialJson;
          }
        }
      }

      // Handle content_block_stop - parse input, display compact summary, move to completed
      if (isContentBlockStop(event) && event.index !== undefined) {
        const pending = pendingToolCalls.get(event.index);
        if (pending) {
          // Try to parse the accumulated JSON
          let parsedInput: Record<string, unknown> = {};
          try {
            if (pending.inputJson) {
              parsedInput = JSON.parse(pending.inputJson);
            }
          } catch {
            // If JSON parsing fails, use empty object
            parsedInput = {};
          }

          // Store in completed map for result formatting
          completedToolCalls.set(pending.toolId, {
            name: pending.name,
            input: parsedInput,
          });

          // Format compact summary for output
          const toolText = formatToolInput(pending.name, parsedInput);
          onOutput?.(`${toolText}\n`);

          // Write full details to agent log
          writer?.appendOutput(`\n${toolText}\n`);
          writer?.appendOutput(`Input: ${JSON.stringify(parsedInput, null, 2)}\n`);

          // Clean up pending entry
          pendingToolCalls.delete(event.index);
        }
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
    // Handle user messages with tool_result blocks to display compact output summaries
    if (message.type === 'user' && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result' &&
            'tool_use_id' in block
          ) {
            const toolUseId = block.tool_use_id as string;
            const completedTool = completedToolCalls.get(toolUseId);
            if (completedTool) {
              // Extract the result content
              let resultContent: unknown = null;
              if ('content' in block) {
                const blockContent = block.content;
                if (typeof blockContent === 'string') {
                  resultContent = blockContent;
                } else if (Array.isArray(blockContent)) {
                  const textParts = blockContent
                    .filter(
                      (c): c is { type: 'text'; text: string } =>
                        typeof c === 'object' &&
                        c !== null &&
                        'type' in c &&
                        c.type === 'text' &&
                        'text' in c
                    )
                    .map((c) => c.text);
                  resultContent = textParts.join('');
                }
              }

              // Format compact output summary
              const outputText = formatToolOutput(
                completedTool.name,
                completedTool.input,
                resultContent
              );
              if (outputText) {
                onOutput?.(`${outputText}\n`);
              }

              // Write full result to agent log
              writer?.appendOutput(`Result: ${JSON.stringify(resultContent)}\n`);

              // Clean up completed tool entry
              completedToolCalls.delete(toolUseId);
            }
          }
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

  // Validate that the agent signaled completion (Risk #4 mitigation)
  // If the agent crashed, timed out, or failed without signaling,
  // we should not proceed with partial data
  if (!fullOutput.includes('PLAN_COMPLETE')) {
    throw new PlanIncompleteError(parallelGroups.length, fullOutput);
  }

  return {
    taskGraph: buildTaskGraph(state.tasks, parallelGroups),
    costUsd,
  };
}
