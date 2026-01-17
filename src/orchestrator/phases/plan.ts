import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PLAN_PROMPT_JSON } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import type { OrchestratorState, Task, TaskGraph } from '../../types/index.js';

export interface PlanOutput {
  parallelGroups: string[][];
  reasoning: string;
}

function truncateOutput(output: string, maxLength = 500): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}... (${output.length - maxLength} more chars)`;
}

export function parsePlanOutput(output: string): PlanOutput {
  const jsonMatch =
    output.match(/```(?:json)?\s*([\s\S]*?)```/) ||
    output.match(/(\{[\s\S]*"parallelGroups"[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error(
      `Failed to parse: No JSON found in output. Agent output: ${truncateOutput(output)}`
    );
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    return {
      parallelGroups: parsed.parallelGroups,
      reasoning: parsed.reasoning || '',
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to parse JSON: ${errorMsg}. Matched content: ${truncateOutput(jsonMatch[1])}`
    );
  }
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
  onOutput?: (text: string) => void
): Promise<PlanResult> {
  const dbPath = join(state.stateDir, 'state.db');
  const config = createAgentConfig('plan', process.cwd(), state.runId, dbPath);

  const tasksJson = JSON.stringify(state.tasks, null, 2);
  const prompt = `${PLAN_PROMPT_JSON}

## Tasks to Plan:
${tasksJson}`;

  let fullOutput = '';
  let costUsd = 0;
  const cwd = process.cwd();

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

  const planOutput = parsePlanOutput(fullOutput);
  return {
    taskGraph: buildTaskGraph(state.tasks, planOutput.parallelGroups),
    costUsd,
  };
}
