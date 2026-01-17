import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Baseline, EvalRunResult } from './types.js';

const BASELINE_FILE = 'evals/baseline.json';

/**
 * Extract scores from eval result into a baseline format
 */
function extractScores(result: EvalRunResult): Record<string, number> {
  const scores: Record<string, number> = {};

  for (const suite of result.suites) {
    // Store suite average
    scores[suite.name] = suite.averageScore;

    // Store individual case scores
    for (const caseResult of suite.cases) {
      const key = `${suite.name}:${caseResult.caseId}`;
      scores[key] = caseResult.grade.score;
    }
  }

  return scores;
}

/**
 * Save current eval results as the regression baseline
 */
export async function saveBaseline(
  result: EvalRunResult,
  baseDir: string = process.cwd()
): Promise<void> {
  const baseline: Baseline = {
    timestamp: result.timestamp,
    scores: extractScores(result),
  };

  const filepath = join(baseDir, BASELINE_FILE);
  await writeFile(filepath, JSON.stringify(baseline, null, 2));
  console.log(`Baseline saved to: ${filepath}`);
}

/**
 * Load the current baseline
 */
export async function loadBaseline(baseDir: string = process.cwd()): Promise<Baseline | null> {
  const filepath = join(baseDir, BASELINE_FILE);

  try {
    const content = await readFile(filepath, 'utf-8');
    return JSON.parse(content) as Baseline;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

/**
 * Check for regressions against the baseline
 * Returns true if no regressions, false if regressions detected
 */
export async function checkRegression(
  result: EvalRunResult,
  threshold = 0.5,
  baseDir: string = process.cwd()
): Promise<boolean> {
  const baseline = await loadBaseline(baseDir);

  if (!baseline) {
    console.log('No baseline found. Run with --baseline first to create one.');
    return true;
  }

  const currentScores = extractScores(result);
  const regressions: Array<{ key: string; baseline: number; current: number; diff: number }> = [];

  for (const [key, baselineScore] of Object.entries(baseline.scores)) {
    const currentScore = currentScores[key];

    if (currentScore === undefined) {
      console.warn(`Warning: ${key} not found in current results (may have been removed)`);
      continue;
    }

    const diff = baselineScore - currentScore;
    if (diff > threshold) {
      regressions.push({
        key,
        baseline: baselineScore,
        current: currentScore,
        diff,
      });
    }
  }

  if (regressions.length > 0) {
    console.log('\nRegressions detected:');
    console.log('-'.repeat(60));

    for (const r of regressions) {
      console.log(`  ${r.key}`);
      console.log(`    Baseline: ${r.baseline.toFixed(2)}`);
      console.log(`    Current:  ${r.current.toFixed(2)}`);
      console.log(`    Diff:     -${r.diff.toFixed(2)}`);
    }

    console.log('-'.repeat(60));
    console.log(`Total regressions: ${regressions.length}`);
    console.log(`Threshold: ${threshold}`);

    return false;
  }

  // Check for improvements (optional info)
  const improvements: Array<{ key: string; baseline: number; current: number; diff: number }> = [];

  for (const [key, currentScore] of Object.entries(currentScores)) {
    const baselineScore = baseline.scores[key];
    if (baselineScore !== undefined) {
      const diff = currentScore - baselineScore;
      if (diff > threshold) {
        improvements.push({
          key,
          baseline: baselineScore,
          current: currentScore,
          diff,
        });
      }
    }
  }

  if (improvements.length > 0) {
    console.log('\nImprovements detected:');
    for (const i of improvements) {
      console.log(
        `  ${i.key}: ${i.baseline.toFixed(2)} → ${i.current.toFixed(2)} (+${i.diff.toFixed(2)})`
      );
    }
  }

  return true;
}

/**
 * Get detailed regression report
 */
export async function getRegressionReport(
  result: EvalRunResult,
  threshold = 0.5,
  baseDir: string = process.cwd()
): Promise<{
  hasRegressions: boolean;
  regressions: Array<{ key: string; baseline: number; current: number; diff: number }>;
  improvements: Array<{ key: string; baseline: number; current: number; diff: number }>;
  unchanged: string[];
}> {
  const baseline = await loadBaseline(baseDir);

  if (!baseline) {
    return {
      hasRegressions: false,
      regressions: [],
      improvements: [],
      unchanged: [],
    };
  }

  const currentScores = extractScores(result);
  const regressions: Array<{ key: string; baseline: number; current: number; diff: number }> = [];
  const improvements: Array<{ key: string; baseline: number; current: number; diff: number }> = [];
  const unchanged: string[] = [];

  for (const [key, baselineScore] of Object.entries(baseline.scores)) {
    const currentScore = currentScores[key];
    if (currentScore === undefined) continue;

    const diff = currentScore - baselineScore;

    if (diff < -threshold) {
      regressions.push({
        key,
        baseline: baselineScore,
        current: currentScore,
        diff: Math.abs(diff),
      });
    } else if (diff > threshold) {
      improvements.push({ key, baseline: baselineScore, current: currentScore, diff });
    } else {
      unchanged.push(key);
    }
  }

  return {
    hasRegressions: regressions.length > 0,
    regressions,
    improvements,
    unchanged,
  };
}
