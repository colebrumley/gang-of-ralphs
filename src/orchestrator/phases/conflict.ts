import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CONFLICT_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import type { Task } from '../../types/index.js';

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
  onOutput?: (text: string) => void
): Promise<ConflictResult> {
  const dbPath = join(stateDir, 'state.db');
  const config = createAgentConfig('conflict', repoDir, runId, dbPath);

  const prompt = CONFLICT_PROMPT.replace(
    '{{conflictFiles}}',
    conflictFiles.map((f) => `- ${f}`).join('\n')
  ).replace('{{taskDescription}}', `${task.title}: ${task.description}`);

  let output = '';
  let costUsd = 0;

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: repoDir,
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
      },
    })) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if ('text' in block) {
            output += block.text;
            onOutput?.(block.text);
          }
        }
      }
      if (message.type === 'result') {
        costUsd = (message as any).total_cost_usd || 0;
      }
    }

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
