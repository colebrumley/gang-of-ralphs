import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, Task, TaskGraph } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { PLAN_PROMPT_JSON } from '../../agents/prompts.js';

export interface PlanOutput {
  parallelGroups: string[][];
  reasoning: string;
}

export function parsePlanOutput(output: string): PlanOutput {
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    output.match(/(\{[\s\S]*"parallelGroups"[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error('Failed to parse: No JSON found in output');
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    return {
      parallelGroups: parsed.parallelGroups,
      reasoning: parsed.reasoning || '',
    };
  } catch (e) {
    throw new Error(`Failed to parse: ${e}`);
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
  const config = createAgentConfig('plan', process.cwd());

  const tasksJson = JSON.stringify(state.tasks, null, 2);
  const prompt = `${PLAN_PROMPT_JSON}

## Tasks to Plan:
${tasksJson}`;

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

  const planOutput = parsePlanOutput(fullOutput);
  return {
    taskGraph: buildTaskGraph(state.tasks, planOutput.parallelGroups),
    costUsd,
  };
}
