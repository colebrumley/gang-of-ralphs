#!/usr/bin/env node
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createCLI } from './cli.js';
import { loadState, saveState, initializeState } from './state/index.js';

async function main() {
  const program = createCLI();
  program.parse();
  const opts = program.opts();

  // Validate spec file exists
  const specPath = resolve(opts.spec);
  try {
    await access(specPath);
  } catch {
    console.error(`Error: Spec file not found: ${specPath}`);
    process.exit(1);
  }

  const stateDir = resolve(opts.stateDir);

  // Load or initialize state
  let state = opts.reset ? null : await loadState(stateDir);

  if (!state) {
    state = initializeState({
      specPath,
      effort: opts.effort,
      stateDir,
      maxLoops: parseInt(opts.maxLoops, 10),
      maxIterations: parseInt(opts.maxIterations, 10),
    });
    console.log(`Initialized new run: ${state.runId}`);
  } else {
    console.log(`Resuming run: ${state.runId}`);
  }

  console.log(`Phase: ${state.phase}`);
  console.log(`Effort: ${state.effort}`);

  if (opts.dryRun) {
    console.log('[dry-run] Would execute phase:', state.phase);
    return;
  }

  // TODO: Execute phase
  console.log('Phase execution not yet implemented');

  await saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
