import { loadAllTestSuites, loadTestSuiteByName } from './loader.js';
import { resolvePrompt, runTestSuiteWithPrompt } from './runner.js';
import type { ComparisonCaseResult, ComparisonResult, TestSuiteResult } from './types.js';

// Re-export printComparisonResult from reporter
export { printComparisonResult } from './reporter.js';

/**
 * Compare two prompts on the same test suite
 */
async function compareSuiteWithPrompts(
  suite: Awaited<ReturnType<typeof loadTestSuiteByName>>,
  promptA: string,
  promptB: string,
  promptContentA: string,
  promptContentB: string
): Promise<ComparisonResult> {
  console.log(`\nRunning suite "${suite.name}" with prompt A (${promptA})...`);
  const resultsA = await runTestSuiteWithPrompt(suite, promptContentA, (caseId, result) => {
    console.log(`  [A] ${caseId}: ${result.grade.score}`);
  });

  console.log(`\nRunning suite "${suite.name}" with prompt B (${promptB})...`);
  const resultsB = await runTestSuiteWithPrompt(suite, promptContentB, (caseId, result) => {
    console.log(`  [B] ${caseId}: ${result.grade.score}`);
  });

  return buildComparisonResult(promptA, promptB, resultsA, resultsB);
}

/**
 * Build comparison result from two suite results
 */
function buildComparisonResult(
  promptA: string,
  promptB: string,
  resultsA: TestSuiteResult,
  resultsB: TestSuiteResult
): ComparisonResult {
  const caseResults: ComparisonCaseResult[] = [];

  for (let i = 0; i < resultsA.cases.length; i++) {
    const caseA = resultsA.cases[i];
    const caseB = resultsB.cases[i];

    let winner: 'A' | 'B' | 'tie';
    if (caseA.grade.score > caseB.grade.score) {
      winner = 'A';
    } else if (caseB.grade.score > caseA.grade.score) {
      winner = 'B';
    } else {
      winner = 'tie';
    }

    caseResults.push({
      caseId: caseA.caseId,
      description: caseA.description,
      scoreA: caseA.grade.score,
      scoreB: caseB.grade.score,
      winner,
    });
  }

  const avgA = resultsA.averageScore;
  const avgB = resultsB.averageScore;

  let overallWinner: 'A' | 'B' | 'tie';
  if (Math.abs(avgA - avgB) < 0.1) {
    overallWinner = 'tie';
  } else if (avgA > avgB) {
    overallWinner = 'A';
  } else {
    overallWinner = 'B';
  }

  const percentDiff = (Math.abs(avgA - avgB) / Math.min(avgA, avgB)) * 100;

  return {
    promptA,
    promptB,
    cases: caseResults,
    averageScoreA: avgA,
    averageScoreB: avgB,
    winner: overallWinner,
    percentDiff,
  };
}

/**
 * Run A/B comparison between two prompts
 */
export async function runComparison(
  promptA: string,
  promptB: string,
  suiteName?: string,
  baseDir: string = process.cwd()
): Promise<ComparisonResult> {
  // Load prompts
  const promptContentA = await resolvePrompt(promptA, baseDir);
  const promptContentB = await resolvePrompt(promptB, baseDir);

  // Load suite(s)
  let suites;
  if (suiteName) {
    const suite = await loadTestSuiteByName(suiteName, baseDir);
    suites = [suite];
  } else {
    suites = await loadAllTestSuites(baseDir);
  }

  if (suites.length === 0) {
    throw new Error('No test suites found');
  }

  // For now, compare on the first suite only
  const suite = suites[0];
  return compareSuiteWithPrompts(suite, promptA, promptB, promptContentA, promptContentB);
}
