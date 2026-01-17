import { Command } from 'commander';
import { printComparisonResult, runComparison } from './compare.js';
import { loadAllTestSuites, loadTestSuiteByName } from './loader.js';
import { checkRegression, saveBaseline } from './regression.js';
import { printEvalRunResult, saveResults } from './reporter.js';
import { runTestSuite } from './runner.js';
import type { EvalRunResult, TestSuiteResult } from './types.js';

const program = new Command();

program.name('eval').description('Eval system for testing C2 prompts').version('1.0.0');

program
  .option('-c, --case <name>', 'Run specific test suite by name')
  .option('--compare <prompts...>', 'A/B compare two prompt versions')
  .option('--baseline', 'Save current results as regression baseline')
  .option('--check', 'Check for regressions against baseline')
  .option('--threshold <n>', 'Regression threshold (default: 0.5)', '0.5')
  .action(async (options) => {
    try {
      const baseDir = process.cwd();

      // A/B Comparison mode
      if (options.compare && options.compare.length >= 2) {
        const [promptA, promptB] = options.compare;
        const result = await runComparison(promptA, promptB, options.case, baseDir);
        printComparisonResult(result);
        return;
      }

      // Load test suites
      let suites;
      if (options.case) {
        const suite = await loadTestSuiteByName(options.case, baseDir);
        suites = [suite];
      } else {
        suites = await loadAllTestSuites(baseDir);
      }

      if (suites.length === 0) {
        console.error('No test suites found in evals/cases/');
        process.exit(1);
      }

      console.log(`Found ${suites.length} test suite(s)`);

      // Run all suites
      const suiteResults: TestSuiteResult[] = [];
      let totalCost = 0;
      let totalDuration = 0;
      let totalScore = 0;

      for (const suite of suites) {
        console.log(`\nRunning suite: ${suite.name}...`);
        const result = await runTestSuite(suite, baseDir, (caseId, caseResult) => {
          console.log(`  ✓ ${caseId}: score ${caseResult.grade.score}`);
        });
        suiteResults.push(result);
        totalCost += result.totalCostUsd;
        totalDuration += result.totalDurationMs;
        totalScore += result.averageScore;
      }

      const evalResult: EvalRunResult = {
        timestamp: new Date().toISOString(),
        suites: suiteResults,
        overallAverageScore: totalScore / suites.length,
        totalCostUsd: totalCost,
        totalDurationMs: totalDuration,
      };

      // Print results
      printEvalRunResult(evalResult);

      // Save results
      await saveResults(evalResult, baseDir);

      // Save baseline if requested
      if (options.baseline) {
        await saveBaseline(evalResult, baseDir);
        console.log('\nBaseline saved.');
      }

      // Check regression if requested
      if (options.check) {
        const threshold = Number.parseFloat(options.threshold);
        const passed = await checkRegression(evalResult, threshold, baseDir);
        if (!passed) {
          console.error('\n❌ Regression detected!');
          process.exit(1);
        }
        console.log('\n✓ No regression detected.');
      }
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    }
  });

export async function runEvalCli(args: string[] = process.argv): Promise<void> {
  await program.parseAsync(args);
}

// Run if invoked directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runEvalCli();
}
