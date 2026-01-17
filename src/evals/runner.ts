import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as prompts from '../agents/prompts.js';
import { gradeOutput } from './grader.js';
import type { TestCase, TestCaseResult, TestSuite, TestSuiteResult } from './types.js';

const PROMPTS_DIR = 'evals/prompts';

/**
 * Resolve a prompt name to its content.
 * First checks built-in prompts, then looks for a file in evals/prompts/
 */
export async function resolvePrompt(
  promptName: string,
  baseDir: string = process.cwd()
): Promise<string> {
  // Check if it's a built-in prompt
  if (promptName in prompts) {
    return (prompts as Record<string, string>)[promptName];
  }

  // Try to load from evals/prompts/
  const possiblePaths = [
    join(baseDir, PROMPTS_DIR, `${promptName}.txt`),
    join(baseDir, PROMPTS_DIR, promptName),
  ];

  for (const path of possiblePaths) {
    try {
      return await readFile(path, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
  }

  throw new Error(`Prompt not found: ${promptName}`);
}

/**
 * Build the full prompt by combining the base prompt with test case input
 */
function buildPrompt(basePrompt: string, input: TestCase['input']): string {
  let prompt = basePrompt;

  // If the input has a spec, append it
  if (input.spec) {
    prompt += `\n\n## Spec File Content:\n${input.spec}`;
  }

  // Add any other input fields
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'spec' && value !== undefined) {
      prompt += `\n\n## ${key}:\n${value}`;
    }
  }

  return prompt;
}

/**
 * Run a single test case and return the raw output
 */
export async function runTestCase(
  promptContent: string,
  testCase: TestCase,
  onOutput?: (text: string) => void
): Promise<{ output: string; costUsd: number; durationMs: number }> {
  const prompt = buildPrompt(promptContent, testCase.input);
  const startTime = Date.now();

  let fullOutput = '';
  let costUsd = 0;

  for await (const message of query({
    prompt,
    options: {
      allowedTools: ['Read', 'Glob'],
      maxTurns: 10,
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

  const durationMs = Date.now() - startTime;
  return { output: fullOutput, costUsd, durationMs };
}

/**
 * Run a single test case with grading
 */
export async function runAndGradeTestCase(
  promptContent: string,
  testCase: TestCase,
  onOutput?: (text: string) => void
): Promise<TestCaseResult> {
  const { output, costUsd, durationMs } = await runTestCase(promptContent, testCase, onOutput);
  const grade = await gradeOutput(output, testCase);

  return {
    caseId: testCase.id,
    description: testCase.description,
    output,
    grade,
    costUsd,
    durationMs,
  };
}

/**
 * Run all test cases in a suite
 */
export async function runTestSuite(
  suite: TestSuite,
  baseDir: string = process.cwd(),
  onProgress?: (caseId: string, result: TestCaseResult) => void
): Promise<TestSuiteResult> {
  const promptContent = await resolvePrompt(suite.prompt, baseDir);
  const results: TestCaseResult[] = [];
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalScore = 0;
  let totalNormalizedScore = 0;

  for (const testCase of suite.cases) {
    const result = await runAndGradeTestCase(promptContent, testCase);
    results.push(result);
    totalCostUsd += result.costUsd;
    totalDurationMs += result.durationMs;
    totalScore += result.grade.score;
    totalNormalizedScore += result.grade.normalizedScore;
    onProgress?.(testCase.id, result);
  }

  const caseCount = suite.cases.length;

  return {
    name: suite.name,
    prompt: suite.prompt,
    cases: results,
    averageScore: totalScore / caseCount,
    averageNormalizedScore: totalNormalizedScore / caseCount,
    totalCostUsd,
    totalDurationMs,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run a suite with a custom prompt (for A/B testing)
 */
export async function runTestSuiteWithPrompt(
  suite: TestSuite,
  promptContent: string,
  onProgress?: (caseId: string, result: TestCaseResult) => void
): Promise<TestSuiteResult> {
  const results: TestCaseResult[] = [];
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let totalScore = 0;
  let totalNormalizedScore = 0;

  for (const testCase of suite.cases) {
    const result = await runAndGradeTestCase(promptContent, testCase);
    results.push(result);
    totalCostUsd += result.costUsd;
    totalDurationMs += result.durationMs;
    totalScore += result.grade.score;
    totalNormalizedScore += result.grade.normalizedScore;
    onProgress?.(testCase.id, result);
  }

  const caseCount = suite.cases.length;

  return {
    name: suite.name,
    prompt: suite.prompt,
    cases: results,
    averageScore: totalScore / caseCount,
    averageNormalizedScore: totalNormalizedScore / caseCount,
    totalCostUsd,
    totalDurationMs,
    timestamp: new Date().toISOString(),
  };
}
