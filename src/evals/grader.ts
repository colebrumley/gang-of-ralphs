import { query } from '@anthropic-ai/claude-agent-sdk';
import { extractJSON } from '../utils/json-parser.js';
import type { GradeResult, TestCase } from './types.js';

const GRADER_PROMPT = `You are evaluating an AI's response.

## Task Description
{{caseDescription}}

## Grading Criteria
{{criteria}}

## Rubric
{{rubric}}

## AI Output
{{output}}

Evaluate the output and respond with JSON:
{
  "score": <1-5>,
  "reasoning": "<why this score>",
  "criteria_met": ["<criterion 1>", ...],
  "criteria_missed": ["<criterion N>", ...]
}`;

interface GraderResponse {
  score: number;
  reasoning: string;
  criteria_met: string[];
  criteria_missed: string[];
}

function buildGraderPrompt(output: string, testCase: TestCase): string {
  return GRADER_PROMPT.replace('{{caseDescription}}', testCase.description)
    .replace('{{criteria}}', testCase.grade.criteria.map((c) => `- ${c}`).join('\n'))
    .replace('{{rubric}}', testCase.grade.rubric)
    .replace('{{output}}', output);
}

/**
 * Grade an output using LLM-as-judge (Haiku for cost efficiency)
 */
export async function gradeOutput(output: string, testCase: TestCase): Promise<GradeResult> {
  const prompt = buildGraderPrompt(output, testCase);

  let fullOutput = '';

  for await (const message of query({
    prompt,
    options: {
      model: 'claude-3-5-haiku-20241022',
      allowedTools: [],
      maxTurns: 1,
    },
  })) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block) {
          fullOutput += block.text;
        }
      }
    }
  }

  try {
    const parsed = extractJSON<GraderResponse>(fullOutput, ['score', 'reasoning']);

    // Normalize score from 1-5 to 0-1
    const normalizedScore = (parsed.score - 1) / 4;

    return {
      score: parsed.score,
      normalizedScore,
      reasoning: parsed.reasoning,
      criteriaMet: parsed.criteria_met || [],
      criteriaMissed: parsed.criteria_missed || [],
    };
  } catch (error) {
    // If parsing fails, return a default low score
    console.error('Failed to parse grader output:', error);
    return {
      score: 1,
      normalizedScore: 0,
      reasoning: `Failed to parse grader output: ${error}`,
      criteriaMet: [],
      criteriaMissed: testCase.grade.criteria,
    };
  }
}

/**
 * Batch grade multiple outputs
 */
export async function gradeOutputs(
  outputs: Array<{ output: string; testCase: TestCase }>,
  onProgress?: (index: number, result: GradeResult) => void
): Promise<GradeResult[]> {
  const results: GradeResult[] = [];

  for (let i = 0; i < outputs.length; i++) {
    const { output, testCase } = outputs[i];
    const result = await gradeOutput(output, testCase);
    results.push(result);
    onProgress?.(i, result);
  }

  return results;
}
