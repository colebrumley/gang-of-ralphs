import { query } from '@anthropic-ai/claude-agent-sdk';
import { extractJSON, JSONExtractionError } from '../utils/json-parser.js';

export interface PromptTestResult {
  promptName: string;
  runs: number;
  successRate: number;
  avgCostUsd: number;
  failures: Array<{
    run: number;
    error: string;
    rawOutput: string;
  }>;
  samples: Array<{
    run: number;
    output: unknown;
    costUsd: number;
  }>;
}

export interface PromptTestConfig {
  prompt: string;
  requiredKeys: string[];
  runs: number;
  allowedTools?: string[];
  maxTurns?: number;
}

/**
 * Run a prompt multiple times and measure success rate.
 * Use this to validate prompts before deploying.
 */
export async function testPrompt(
  name: string,
  config: PromptTestConfig
): Promise<PromptTestResult> {
  const result: PromptTestResult = {
    promptName: name,
    runs: config.runs,
    successRate: 0,
    avgCostUsd: 0,
    failures: [],
    samples: [],
  };

  let successCount = 0;
  let totalCost = 0;

  for (let run = 1; run <= config.runs; run++) {
    let fullOutput = '';
    let costUsd = 0;

    try {
      for await (const message of query({
        prompt: config.prompt,
        options: {
          allowedTools: config.allowedTools || ['Read', 'Glob'],
          maxTurns: config.maxTurns || 10,
        },
      })) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block) {
              fullOutput += block.text;
            }
          }
        }
        if (message.type === 'result') {
          costUsd = (message as any).total_cost_usd || 0;
        }
      }

      // Try to extract JSON
      const parsed = extractJSON(fullOutput, config.requiredKeys);
      successCount++;
      totalCost += costUsd;

      result.samples.push({
        run,
        output: parsed,
        costUsd,
      });
    } catch (error) {
      result.failures.push({
        run,
        error: error instanceof Error ? error.message : String(error),
        rawOutput: fullOutput.slice(0, 500),
      });
    }
  }

  result.successRate = successCount / config.runs;
  result.avgCostUsd = totalCost / Math.max(successCount, 1);

  return result;
}

export function printTestReport(result: PromptTestResult): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Prompt: ${result.promptName}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Runs: ${result.runs}`);
  console.log(`Success Rate: ${(result.successRate * 100).toFixed(1)}%`);
  console.log(`Avg Cost: $${result.avgCostUsd.toFixed(4)}`);

  if (result.failures.length > 0) {
    console.log(`\nFailures (${result.failures.length}):`);
    for (const f of result.failures.slice(0, 3)) {
      console.log(`  Run ${f.run}: ${f.error}`);
    }
  }

  if (result.samples.length > 0) {
    console.log(`\nSample output (run ${result.samples[0].run}):`);
    console.log(JSON.stringify(result.samples[0].output, null, 2).slice(0, 500));
  }
}

/**
 * Run all prompt tests and return summary
 */
export async function runAllPromptTests(
  tests: Array<{ name: string; config: PromptTestConfig }>
): Promise<{
  results: PromptTestResult[];
  overallSuccessRate: number;
  passed: boolean;
}> {
  const results: PromptTestResult[] = [];

  for (const test of tests) {
    const result = await testPrompt(test.name, test.config);
    results.push(result);
    printTestReport(result);
  }

  const overallSuccessRate =
    results.reduce((a, r) => a + r.successRate, 0) / results.length;

  return {
    results,
    overallSuccessRate,
    passed: overallSuccessRate >= 0.9, // 90% threshold
  };
}
