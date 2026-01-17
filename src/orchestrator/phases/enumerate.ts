import { readFile } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorState, Task } from '../../types/index.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { ENUMERATE_PROMPT } from '../../agents/prompts.js';

export function parseEnumerateOutput(output: string): Task[] {
  // Extract JSON from markdown code blocks or raw JSON
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    output.match(/(\{[\s\S]*"tasks"[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error('Failed to parse: No JSON found in output');
  }

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());
    return parsed.tasks.map((t: Record<string, unknown>) => ({
      id: t.id as string,
      title: t.title as string,
      description: t.description as string,
      status: 'pending' as const,
      dependencies: (t.dependencies as string[]) || [],
      estimatedIterations: (t.estimatedIterations as number) || 10,
      assignedLoopId: null,
    }));
  } catch (e) {
    throw new Error(`Failed to parse: ${e}`);
  }
}

export async function executeEnumerate(
  state: OrchestratorState,
  onOutput?: (text: string) => void
): Promise<Task[]> {
  const specContent = await readFile(state.specPath, 'utf-8');
  const config = createAgentConfig('enumerate', process.cwd());

  const prompt = `${ENUMERATE_PROMPT}

## Spec File Content:
${specContent}`;

  let fullOutput = '';

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
  }

  return parseEnumerateOutput(fullOutput);
}
