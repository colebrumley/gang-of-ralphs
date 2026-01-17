#!/usr/bin/env tsx
import { testPrompt, printTestReport } from '../src/testing/prompt-harness.js';
import { ENUMERATE_PROMPT_JSON, PLAN_PROMPT_JSON, REVIEW_PROMPT_JSON } from '../src/agents/prompts.js';

const TEST_SPEC = `
# Test Feature
Create a greeting function.
## Requirements
1. greet(name) returns "Hello, {name}!"
2. Handle empty name
`;

async function main() {
  console.log('Testing prompts against sample spec...\n');

  // Test enumerate prompt
  const enumerateResult = await testPrompt('enumerate', {
    prompt: `${ENUMERATE_PROMPT_JSON}\n\n## Spec:\n${TEST_SPEC}`,
    requiredKeys: ['tasks'],
    runs: 3,
  });
  printTestReport(enumerateResult);

  // Test plan prompt (with sample tasks)
  const sampleTasks = [
    { id: 't1', title: 'Create greet function', dependencies: [] },
    { id: 't2', title: 'Add tests', dependencies: ['t1'] },
  ];
  const planResult = await testPrompt('plan', {
    prompt: `${PLAN_PROMPT_JSON}\n\n## Tasks:\n${JSON.stringify(sampleTasks)}`,
    requiredKeys: ['parallelGroups'],
    runs: 3,
  });
  printTestReport(planResult);

  // Test review prompt
  const reviewResult = await testPrompt('review', {
    prompt: `${REVIEW_PROMPT_JSON}\n\n## Implementation Summary:\nCreated greet.ts with greet() function and tests. All tests pass.`,
    requiredKeys: ['passed'],
    runs: 3,
  });
  printTestReport(reviewResult);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const allResults = [enumerateResult, planResult, reviewResult];
  const avgSuccess = allResults.reduce((a, r) => a + r.successRate, 0) / allResults.length;
  console.log(`Overall Success Rate: ${(avgSuccess * 100).toFixed(1)}%`);

  if (avgSuccess < 0.9) {
    console.log('\nWARNING: Prompts need improvement before production use.');
    process.exit(1);
  } else {
    console.log('\nPrompts are ready for use.');
  }
}

main().catch(console.error);
