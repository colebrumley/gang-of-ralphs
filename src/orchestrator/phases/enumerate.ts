import { readFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, Task } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { ENUMERATE_PROMPT_JSON } from '../../agents/prompts.js';
import { extractJSON } from '../../utils/json-parser.js';

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
        `Task "${task.title}" (${task.id}) has a short description. ` +
        `More detail helps the build agent.`
      );
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

export function parseEnumerateOutput(output: string): Task[] {
  // Use robust JSON parser (Risk #2 mitigation)
  const parsed = extractJSON<{ tasks: any[] }>(output, ['tasks']);

  return parsed.tasks.map((t: any) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: 'pending' as const,
    dependencies: t.dependencies || [],
    estimatedIterations: t.estimatedIterations || 10,
    assignedLoopId: null,
  }));
}

export interface EnumerateResult {
  tasks: Task[];
  costUsd: number;
}

export async function executeEnumerate(
  state: OrchestratorState,
  onOutput?: (text: string) => void
): Promise<EnumerateResult> {
  const specContent = await readFile(state.specPath, 'utf-8');
  const config = createAgentConfig('enumerate', process.cwd());

  const prompt = `${ENUMERATE_PROMPT_JSON}

## Spec File Content:
${specContent}`;

  let fullOutput = '';
  let costUsd = 0;

  for await (const message of query({
    prompt,
    options: {
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

  return {
    tasks: parseEnumerateOutput(fullOutput),
    costUsd,
  };
}
