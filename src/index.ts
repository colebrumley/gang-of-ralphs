#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCLI } from './cli.js';
import { closeDatabase, createDatabase } from './db/index.js';
import { createTracer } from './debug/index.js';
import { getExitCode, runOrchestrator } from './orchestrator/index.js';
import { printDryRunSummary } from './orchestrator/summary.js';
import { initializeState, loadState, saveRun } from './state/index.js';
import type { OrchestratorState } from './types/index.js';

async function cleanWorktrees(runId?: string) {
  const worktreeDir = join(process.cwd(), '.sq', 'worktrees');

  if (!existsSync(worktreeDir)) {
    console.log('No worktrees to clean');
    return;
  }

  const dirs = readdirSync(worktreeDir);

  for (const dir of dirs) {
    if (runId && !dir.includes(runId)) continue;

    const worktreePath = join(worktreeDir, dir);
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
      console.log(`Removed worktree: ${dir}`);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
      console.log(`Force removed: ${dir}`);
    }
  }

  // Prune worktree list
  try {
    execSync('git worktree prune', { stdio: 'pipe' });
  } catch {
    // Ignore if not in a git repo
  }
  console.log('Worktree cleanup complete');
}

async function main() {
  const args = process.argv.slice(2);

  // Handle clean subcommand
  if (args[0] === 'clean') {
    const runId = args.includes('--run') ? args[args.indexOf('--run') + 1] : undefined;
    await cleanWorktrees(runId);
    return;
  }

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

  // Handle --reset flag: clear existing state before starting fresh
  if (opts.reset) {
    if (existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true, force: true });
      console.log(`Cleared existing state: ${stateDir}`);
    }
  }

  let state: OrchestratorState;

  // Try to resume existing run if --resume flag is set
  if (opts.resume) {
    const loadedState = loadState(stateDir);
    if (loadedState) {
      state = loadedState;
      console.log(`Resuming run: ${state.runId}`);
      console.log(`Current phase: ${state.phase}`);
    } else {
      console.error('Error: --resume specified but no existing run found');
      process.exit(1);
    }
  } else {
    // Initialize fresh state
    state = initializeState({
      specPath,
      effort: opts.effort,
      stateDir,
      maxLoops: Number.parseInt(opts.maxLoops, 10),
      maxIterations: Number.parseInt(opts.maxIterations, 10),
      useWorktrees: !opts.noWorktrees,
      debug: opts.debug,
    });

    // Initialize database and save the new run
    const dbPath = join(stateDir, 'state.db');
    if (!existsSync(stateDir)) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(stateDir, { recursive: true });
    }
    createDatabase(dbPath);
    saveRun(state);
    console.log(`Initialized new run: ${state.runId}`);
  }

  // Initialize debug tracer
  const tracer = createTracer(opts.debug, stateDir);
  if (opts.debug) {
    await tracer.init(state.runId, specPath, state.effort);
    console.log(`Debug tracing enabled: ${stateDir}/debug/${state.runId}/`);
  }

  console.log(`Phase: ${state.phase}`);
  console.log(`Effort: ${state.effort}`);

  if (opts.dryRun) {
    console.log('[dry-run] Running ENUMERATE and PLAN phases...\n');

    // Run ENUMERATE phase
    state = await runOrchestrator(state, {
      onPhaseStart: (phase) => console.log(`Starting phase: ${phase}`),
      onPhaseComplete: (phase, success) =>
        console.log(`Phase ${phase} ${success ? 'completed' : 'failed'}`),
      onOutput: (text) => process.stdout.write(text),
      tracer,
    });

    if (state.context.errors.length > 0) {
      console.error('Errors during ENUMERATE:', state.context.errors);
      process.exit(1);
    }

    // Run PLAN phase (may need to skip review if effort config enables it)
    while (state.phase === 'review' || state.phase === 'plan') {
      state = await runOrchestrator(state, {
        onPhaseStart: (phase) => console.log(`Starting phase: ${phase}`),
        onPhaseComplete: (phase, success) =>
          console.log(`Phase ${phase} ${success ? 'completed' : 'failed'}`),
        onOutput: (text) => process.stdout.write(text),
        tracer,
      });

      if (state.context.errors.length > 0) {
        console.error('Errors during PLAN:', state.context.errors);
        process.exit(1);
      }

      // Stop once we've reached build phase (plan complete)
      if (state.phase === 'build') break;
    }

    // Print dry-run summary
    printDryRunSummary(state);
    return;
  }

  if (state.phase === 'complete') {
    console.log('Run already complete!');
    process.exit(0);
  }

  // TUI mode
  if (opts.tui) {
    const { render } = await import('ink');
    const { App } = await import('./tui/App.js');
    const React = await import('react');

    render(
      React.createElement(App, { initialState: state, tracer: opts.debug ? tracer : undefined })
    );
    return; // TUI handles everything
  }

  // Set up signal handlers for graceful shutdown (non-TUI mode)
  let shuttingDown = false;
  const handleShutdown = () => {
    if (shuttingDown) return; // Prevent double-handling
    shuttingDown = true;

    console.log('\nInterrupted - saving state...');
    try {
      // Mark any running loops as interrupted for proper resume
      const updatedLoops = state.activeLoops.map((loop) =>
        loop.status === 'running'
          ? {
              ...loop,
              status: 'interrupted' as const,
              stuckIndicators: {
                ...loop.stuckIndicators,
                lastError: 'Process interrupted by signal',
              },
            }
          : loop
      );
      state.activeLoops = updatedLoops;

      // Log the interruption to trace
      tracer.logError('Process interrupted by signal (SIGINT/SIGTERM)', state.phase);

      saveRun(state);
      tracer.finalize().catch(() => {});
      closeDatabase();
    } catch {
      // Ignore errors during shutdown - best effort save
    }
    process.exit(130); // Standard exit code for SIGINT
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  // Run phases until complete or error
  let iterations = 0;
  const maxIterations = 50; // Safety limit

  // Line buffer for loop output - accumulate partial lines until newline
  const loopLineBuffers = new Map<string, string>();

  while (state.phase !== 'complete' && iterations < maxIterations) {
    iterations++;
    const prevCompletedCount = state.completedTasks.length;

    state = await runOrchestrator(state, {
      onPhaseStart: (phase) => console.log(`Starting phase: ${phase}`),
      onPhaseComplete: (phase, success) =>
        console.log(`Phase ${phase} ${success ? 'completed' : 'failed'}`),
      onOutput: (text) => process.stdout.write(text),
      onLoopOutput: (loopId, text) => {
        // Buffer partial lines - only print complete lines
        const currentBuffer = loopLineBuffers.get(loopId) || '';
        const buffered = currentBuffer + text;
        const lines = buffered.split('\n');
        // Last element is either empty (if text ended with \n) or a partial line
        loopLineBuffers.set(loopId, lines.pop() || '');
        for (const line of lines) {
          console.log(`[${loopId.slice(0, 8)}] ${line}`);
        }
      },
      tracer,
    });

    // Save state after each phase for resume support
    saveRun(state);

    // Break if stuck or errored
    const exitCode = getExitCode(state);
    if (exitCode !== 0) {
      break;
    }

    // For build phase, check if we made progress
    if (state.phase === 'build' && state.completedTasks.length === prevCompletedCount) {
      // No progress made, may be stuck
      console.log('No progress in build phase, checking for issues...');
    }
  }

  // Clean up signal handlers before normal exit
  process.off('SIGINT', handleShutdown);
  process.off('SIGTERM', handleShutdown);

  const exitCode = getExitCode(state);

  if (state.phase === 'complete') {
    console.log('\n✓ All tasks completed successfully!');
  } else if (exitCode === 2) {
    console.log('\n⚠ Loop stuck - needs intervention');
  } else {
    console.log(`\nPhase complete. Next: ${state.phase}`);
    console.log('Run again to continue (or use outer Ralph loop)');
  }

  if (opts.debug) {
    await tracer.finalize();
  }

  closeDatabase();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
