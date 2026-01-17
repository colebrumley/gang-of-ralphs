import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EffortLevel, OrchestratorState } from '../types/index.js';
import { OrchestratorStateSchema } from './schema.js';

const STATE_FILE = 'state.json';

export interface InitStateOptions {
  specPath: string;
  effort: EffortLevel;
  stateDir: string;
  maxLoops: number;
  maxIterations: number;
}

export function initializeState(options: InitStateOptions): OrchestratorState {
  return {
    runId: randomUUID(),
    specPath: options.specPath,
    effort: options.effort,
    phase: 'enumerate',
    phaseHistory: [],
    tasks: [],
    taskGraph: null,
    activeLoops: [],
    completedTasks: [],
    pendingReview: false,
    reviewType: null,
    revisionCount: 0,
    context: {
      discoveries: [],
      errors: [],
      decisions: [],
    },
    maxLoops: options.maxLoops,
    maxIterations: options.maxIterations,
    stateDir: options.stateDir,
  };
}

export async function saveState(state: OrchestratorState): Promise<void> {
  await mkdir(state.stateDir, { recursive: true });
  const filePath = join(state.stateDir, STATE_FILE);
  await writeFile(filePath, JSON.stringify(state, null, 2));
}

export async function loadState(stateDir: string): Promise<OrchestratorState | null> {
  const filePath = join(stateDir, STATE_FILE);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return OrchestratorStateSchema.parse(parsed);
  } catch {
    return null;
  }
}

export { OrchestratorStateSchema } from './schema.js';
