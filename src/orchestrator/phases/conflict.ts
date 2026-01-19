import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CONFLICT_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import type { DebugTracer } from '../../debug/index.js';
import type { EffortLevel, Task } from '../../types/index.js';
import {
  type StreamEvent,
  isResultMessage,
  isStreamEventMessage,
  isToolProgressMessage,
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
            output += textDelta;
            writer?.appendOutput(textDelta);
            onOutput?.(textDelta);
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
