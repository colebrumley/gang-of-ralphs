import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { REVISE_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import type { DebugTracer } from '../../debug/index.js';
import type { OrchestratorState, ReviewIssue } from '../../types/index.js';

export interface ReviseResult {
  success: boolean;
  analysis?: string;
  fixes?: Array<{
    issue: string;
    file: string;
    action: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  tasksToRetry?: string[];
  additionalContext?: string;
  costUsd: number;
}

interface ParsedReviseOutput {
  analysis: string;
  fixes: Array<{
    issue: string;
    file: string;
    action: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  tasksToRetry: string[];
  additionalContext: string;
}

function formatReviewIssues(issues: ReviewIssue[]): string {
  if (issues.length === 0) {
    return 'No specific issues recorded.';
  }

  return issues
    .map((issue, i) => {
      const parts = [`${i + 1}. **${issue.type}** in \`${issue.file}\``];
      if (issue.line) {
        parts[0] += ` (line ${issue.line})`;
      }
      parts.push(`   - Issue: ${issue.description}`);
      if (issue.suggestion) {
        parts.push(`   - Suggestion: ${issue.suggestion}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

export function parseReviseOutput(output: string): ParsedReviseOutput | null {
  const jsonMatch =
    output.match(/```(?:json)?\s*([\s\S]*?)```/) || output.match(/(\{[\s\S]*"analysis"[\s\S]*\})/);

  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    return {
      analysis: parsed.analysis || '',
      fixes: parsed.fixes || [],
      tasksToRetry: parsed.tasksToRetry || [],
      additionalContext: parsed.additionalContext || '',
    };
  } catch {
    return null;
  }
}

export async function executeRevise(
  state: OrchestratorState,
  onOutput?: (text: string) => void,
  tracer?: DebugTracer
): Promise<ReviseResult> {
  const dbPath = join(state.stateDir, 'state.db');
  const effortConfig = getEffortConfig(state.effort);
  const model = getModelId(effortConfig.models.revise);
  const config = createAgentConfig('revise', process.cwd(), state.runId, dbPath, model);

  // Format completed tasks for context
  const completedTasksInfo = state.completedTasks
    .map((id) => {
      const task = state.tasks.find((t) => t.id === id);
      return task ? `- ${id}: ${task.title}\n  ${task.description}` : `- ${id}`;
    })
    .join('\n');

  // Build the prompt with review issues
  const prompt = REVISE_PROMPT.replace(
    '{{reviewIssues}}',
    formatReviewIssues(state.context.reviewIssues)
  )
    .replace('{{specPath}}', state.specPath)
    .replace('{{completedTasks}}', completedTasksInfo || 'None');

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  const cwd = process.cwd();

  const writer = tracer?.startAgentCall({
    phase: 'revise',
    prompt,
  });

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
        model: config.model,
        includePartialMessages: true,
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

    // Check for completion signal
    if (!fullOutput.includes('REVISE_COMPLETE')) {
      return {
        success: false,
        costUsd,
      };
    }

    // Parse the fix plan
    const parsed = parseReviseOutput(fullOutput);
    if (!parsed) {
      return {
        success: true, // Agent completed but we couldn't parse output
        costUsd,
      };
    }

    return {
      success: true,
      analysis: parsed.analysis,
      fixes: parsed.fixes,
      tasksToRetry: parsed.tasksToRetry,
      additionalContext: parsed.additionalContext,
      costUsd,
    };
  } catch (_e) {
    return {
      success: false,
      costUsd,
    };
  }
}
