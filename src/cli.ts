import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

function getGitCommitHash(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(__dirname, '..');
    return execSync('git rev-parse --short HEAD', {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: repoRoot,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const gitHash = getGitCommitHash();
    return `${pkg.version} (${gitHash})`;
  } catch {
    return `unknown (${getGitCommitHash()})`;
  }
}

export function createCLI(): Command {
  const program = new Command();

  program
    .name('sq')
    .version(getVersion(), '-v, --version', 'Show version number and git commit')
    .description('Claude Squad - AI orchestrator with parallel agent loops')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--effort <level>', 'Effort level: low|medium|high|max', 'medium')
    .option('--max-loops <n>', 'Max concurrent parallel loops', '4')
    .option('--max-iterations <n>', 'Max iterations per loop', '50')
    .option('--state-dir <path>', 'State directory', '.sq')
    .option('--resume', 'Resume existing run', false)
    .option('--reset', 'Discard state and start fresh', false)
    .option('--dry-run', 'Show what would happen', false)
    .option('--no-tui', 'Disable TUI interface')
    .option('--no-worktrees', 'Disable git worktree isolation')
    .option('--debug', 'Enable debug tracing to .sq/debug/<runId>/', false);

  return program;
}
