import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CONFLICT_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import type { DebugTracer } from '../../debug/index.js';
import { formatToolInput, formatToolOutput } from '../../tui/tool-formatting.js';
import type { EffortLevel, Task } from '../../types/index.js';
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

export interface ConflictResult {
  resolved: boolean;
  error?: string;
  costUsd: number;
}

export async function resolveConflict(
  task: Task,
  conflictFiles: string[],
  repoDir: string,
  runId: string,
  stateDir: string,
  effort: EffortLevel,
  onOutput?: (text: string) => void,
  tracer?: DebugTracer
): Promise<ConflictResult> {
  const dbPath = join(stateDir, 'state.db');
  const effortConfig = getEffortConfig(effort);
  const model = getModelId(effortConfig.models.conflict);
  const config = createAgentConfig('conflict', repoDir, runId, dbPath, model);

  const prompt = CONFLICT_PROMPT.replace(
    '{{conflictFiles}}',
    conflictFiles.map((f) => `- ${f}`).join('\n')
  ).replace('{{taskDescription}}', `${task.title}: ${task.description}`);

  let output = '';
  let costUsd = 0;
  const startTime = Date.now();

  const writer = tracer?.startAgentCall({
    phase: 'conflict',
    prompt,
  });

  // Pending tool calls map: index -> tool info with accumulated input JSON
  const pendingToolCalls = new Map<number, { name: string; toolId: string; inputJson: string }>();
  // Completed tool calls map: toolId -> tool info with parsed input (for result formatting)
  const completedToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: repoDir,
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
        model: config.model,
        includePartialMessages: true,
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
            output += textDelta;
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
          if ('text' in block && !output.includes(block.text)) {
            output += block.text;
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

    if (output.includes('CONFLICT_RESOLVED')) {
      return { resolved: true, costUsd };
    }

    const failMatch = output.match(/CONFLICT_FAILED:\s*(.+)/);
    return {
      resolved: false,
      error: failMatch?.[1] || 'Unknown conflict resolution failure',
      costUsd,
    };
  } catch (e) {
    return { resolved: false, error: String(e), costUsd };
  }
}
