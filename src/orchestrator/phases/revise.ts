import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { REVISE_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
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
  onOutput?: (text: string) => void
): Promise<ReviseResult> {
  const dbPath = join(state.stateDir, 'state.db');
  const config = createAgentConfig('revise', process.cwd(), state.runId, dbPath);

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

  const cwd = process.cwd();

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd,
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
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
