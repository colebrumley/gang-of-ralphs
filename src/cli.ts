import { Command } from 'commander';
import type { EffortLevel } from './types/index.js';

export interface CLIOptions {
  spec: string;
  effort: EffortLevel;
  maxLoops: number;
  maxIterations: number;
  stateDir: string;
  resume: boolean;
  reset: boolean;
  dryRun: boolean;
  tui: boolean;
  noWorktrees: boolean;
}

export function parseArgs(args: string[]): CLIOptions {
  const program = new Command();

  program
    .name('c2')
    .description('AI orchestrator with parallel Ralph Wiggum loops')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--effort <level>', 'Effort level: low|medium|high|max', 'medium')
    .option('--max-loops <n>', 'Max concurrent parallel loops', '4')
    .option('--max-iterations <n>', 'Max iterations per loop', '20')
    .option('--state-dir <path>', 'State directory', '.c2')
    .option('--resume', 'Resume existing run', false)
    .option('--reset', 'Discard state and start fresh', false)
    .option('--dry-run', 'Show what would happen', false)
    .option('--tui', 'Run with TUI interface', false)
    .option('--no-worktrees', 'Disable git worktree isolation', false);

  program.parse(['node', 'c2', ...args]);
  const opts = program.opts();

  return {
    spec: opts.spec,
    effort: opts.effort as EffortLevel,
    maxLoops: parseInt(opts.maxLoops, 10),
    maxIterations: parseInt(opts.maxIterations, 10),
    stateDir: opts.stateDir,
    resume: opts.resume,
    reset: opts.reset,
    dryRun: opts.dryRun,
    tui: opts.tui,
    noWorktrees: opts.noWorktrees ?? false,
  };
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name('c2')
    .description('AI orchestrator with parallel Ralph Wiggum loops')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--effort <level>', 'Effort level: low|medium|high|max', 'medium')
    .option('--max-loops <n>', 'Max concurrent parallel loops', '4')
    .option('--max-iterations <n>', 'Max iterations per loop', '20')
    .option('--state-dir <path>', 'State directory', '.c2')
    .option('--resume', 'Resume existing run', false)
    .option('--reset', 'Discard state and start fresh', false)
    .option('--dry-run', 'Show what would happen', false)
    .option('--tui', 'Run with TUI interface', false)
    .option('--no-worktrees', 'Disable git worktree isolation', false);

  return program;
}

export interface CleanOptions {
  run?: string;
  all: boolean;
}

export function createCleanCLI(): Command {
  const program = new Command();

  program
    .name('c2 clean')
    .description('Clean up stale worktrees')
    .option('--run <id>', 'Clean worktrees for specific run')
    .option('--all', 'Clean all c2 worktrees', false);

  return program;
}
