import type { OrchestratorState } from '../types/index.js';

/**
 * Prints a dry-run summary showing tasks, dependencies, and execution plan.
 */
export function printDryRunSummary(state: OrchestratorState): void {
  console.log('\n=== DRY RUN SUMMARY ===\n');

  // Print tasks with dependencies
  console.log(`Tasks (${state.tasks.length}):`);
  for (const task of state.tasks) {
    const deps =
      task.dependencies.length > 0
        ? `depends on: ${task.dependencies.join(', ')}`
        : 'depends on: none';
    console.log(`  [${task.id}] ${task.title} - ${deps}`);
  }

  // Print execution plan
  if (state.taskGraph) {
    console.log('\nExecution Plan:');
    for (let i = 0; i < state.taskGraph.parallelGroups.length; i++) {
      const group = state.taskGraph.parallelGroups[i];
      const parallel = group.length > 1 ? ' (parallel)' : '';
      console.log(`  Group ${i + 1}${parallel}: [${group.join(', ')}]`);
    }

    // Calculate estimated agent spawns (one per task)
    const totalTasks = state.tasks.length;
    const totalGroups = state.taskGraph.parallelGroups.length;

    console.log(`\nEstimated agent spawns: ${totalTasks}`);
    console.log(`Estimated iterations: ${totalGroups} groups`);
  } else {
    console.log('\nNo execution plan generated.');
  }

  console.log('');
}
