import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComparisonResult, EvalRunResult, TestSuiteResult } from './types.js';

const RESULTS_DIR = 'evals/results';

/**
 * Format a score with color indicators for terminal output
 */
function formatScore(score: number): string {
  const scoreStr = score.toFixed(1);
  if (score >= 4) return `\x1b[32m${scoreStr}\x1b[0m`; // Green
  if (score >= 3) return `\x1b[33m${scoreStr}\x1b[0m`; // Yellow
  return `\x1b[31m${scoreStr}\x1b[0m`; // Red
}

/**
 * Print a test suite result to the console
 */
export function printTestSuiteResult(result: TestSuiteResult): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Suite: ${result.name}`);
  console.log(`Prompt: ${result.prompt}`);
  console.log(`${'='.repeat(60)}`);

  const headers = ['Case', 'Score', 'Cost', 'Duration'];
  const rows = result.cases.map((c) => [
    c.caseId.slice(0, 20),
    formatScore(c.grade.score),
    `$${c.costUsd.toFixed(4)}`,
    `${(c.durationMs / 1000).toFixed(1)}s`,
  ]);

  // Print header
  console.log(`\n${headers.join(' | ')}`);
  console.log('-'.repeat(60));

  // Print rows
  for (const row of rows) {
    console.log(row.join(' | '));
  }

  // Print summary
  console.log('-'.repeat(60));
  console.log(`Average Score: ${formatScore(result.averageScore)}`);
  console.log(`Total Cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(`Total Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
}

/**
 * Print full eval run results to console
 */
export function printEvalRunResult(result: EvalRunResult): void {
  for (const suite of result.suites) {
    printTestSuiteResult(suite);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('OVERALL SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Suites: ${result.suites.length}`);
  console.log(`Overall Average Score: ${formatScore(result.overallAverageScore)}`);
  console.log(`Total Cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(`Total Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`Timestamp: ${result.timestamp}`);
}

/**
 * Print A/B comparison result to console
 */
export function printComparisonResult(result: ComparisonResult): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`A/B Comparison: ${result.promptA} vs ${result.promptB}`);
  console.log(`${'='.repeat(70)}`);

  const headers = ['Case', 'A Score', 'B Score', 'Winner'];
  const colWidths = [24, 10, 10, 10];

  // Print header
  console.log(`\n${headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ')}`);
  console.log('-'.repeat(70));

  // Print rows
  for (const c of result.cases) {
    const winner = c.winner === 'tie' ? 'tie' : c.winner === 'A' ? result.promptA : result.promptB;
    console.log(
      [
        c.caseId.slice(0, 22).padEnd(colWidths[0]),
        formatScore(c.scoreA).padEnd(colWidths[1] + 9), // Account for ANSI codes
        formatScore(c.scoreB).padEnd(colWidths[2] + 9),
        winner.padEnd(colWidths[3]),
      ].join(' | ')
    );
  }

  // Print summary
  console.log('-'.repeat(70));
  console.log(`Average A: ${formatScore(result.averageScoreA)}`);
  console.log(`Average B: ${formatScore(result.averageScoreB)}`);

  const winnerStr =
    result.winner === 'tie'
      ? 'Tie'
      : `${result.winner === 'A' ? result.promptA : result.promptB} (+${result.percentDiff.toFixed(1)}%)`;
  console.log(`Winner: ${winnerStr}`);
}

/**
 * Generate a timestamp string for file naming
 */
function generateTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Save eval run results to JSON file
 */
export async function saveResults(
  result: EvalRunResult,
  baseDir: string = process.cwd()
): Promise<string> {
  const resultsDir = join(baseDir, RESULTS_DIR);
  await mkdir(resultsDir, { recursive: true });

  const timestamp = generateTimestamp();
  const filename = `${timestamp}.json`;
  const filepath = join(resultsDir, filename);

  await writeFile(filepath, JSON.stringify(result, null, 2));
  console.log(`\nResults saved to: ${filepath}`);

  return filepath;
}

/**
 * Generate markdown report
 */
export function generateMarkdownReport(result: EvalRunResult): string {
  const lines: string[] = [];

  lines.push('# Eval Run Report');
  lines.push(`\n**Timestamp:** ${result.timestamp}`);
  lines.push(`**Overall Score:** ${result.overallAverageScore.toFixed(2)}`);
  lines.push(`**Total Cost:** $${result.totalCostUsd.toFixed(4)}`);
  lines.push('');

  for (const suite of result.suites) {
    lines.push(`## ${suite.name}`);
    lines.push(`**Prompt:** ${suite.prompt}`);
    lines.push(`**Average Score:** ${suite.averageScore.toFixed(2)}`);
    lines.push('');
    lines.push('| Case | Score | Reasoning |');
    lines.push('|------|-------|-----------|');

    for (const c of suite.cases) {
      const reasoning = c.grade.reasoning.slice(0, 50).replace(/\|/g, '\\|');
      lines.push(`| ${c.caseId} | ${c.grade.score} | ${reasoning}... |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
