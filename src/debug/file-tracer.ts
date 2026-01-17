import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Phase } from '../types/index.js';
import type { DebugEvent, DebugTracer, TraceFile } from './types.js';

class FileTracer implements DebugTracer {
  private stateDir: string;
  private debugDir = '';
  private outputsDir = '';
  private trace: TraceFile | null = null;
  private outputCounter = 0;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  async init(runId: string, specPath: string, effort: string): Promise<void> {
    this.debugDir = join(this.stateDir, 'debug', runId);
    this.outputsDir = join(this.debugDir, 'outputs');

    mkdirSync(this.debugDir, { recursive: true });
    mkdirSync(this.outputsDir, { recursive: true });

    this.trace = {
      runId,
      specPath,
      effort,
      startedAt: new Date().toISOString(),
      completedAt: null,
      events: [],
    };

    await this.saveTrace();
  }

  async finalize(): Promise<void> {
    if (this.trace) {
      this.trace.completedAt = new Date().toISOString();
      await this.saveTrace();
    }
  }

  logPhaseStart(phase: Phase, inputState: Record<string, unknown>): void {
    this.addEvent({
      type: 'phase_start',
      timestamp: new Date().toISOString(),
      phase,
      inputState,
    });
  }

  logPhaseComplete(phase: Phase, success: boolean, costUsd: number, summary: string): void {
    this.addEvent({
      type: 'phase_complete',
      timestamp: new Date().toISOString(),
      phase,
      success,
      costUsd,
      summary,
    });
  }

  async logAgentCall(opts: {
    phase: Phase;
    loopId?: string;
    iteration?: number;
    prompt: string;
    response: string;
    costUsd: number;
    durationMs: number;
  }): Promise<void> {
    this.outputCounter++;
    const prefix = opts.loopId
      ? `${opts.phase}-${opts.loopId.slice(0, 8)}-iter-${opts.iteration}`
      : opts.phase;

    const promptFile = `${prefix}-${this.outputCounter}-prompt.txt`;
    const responseFile = `${prefix}-${this.outputCounter}-response.txt`;

    await writeFile(join(this.outputsDir, promptFile), opts.prompt);
    await writeFile(join(this.outputsDir, responseFile), opts.response);

    this.addEvent({
      type: 'agent_call',
      timestamp: new Date().toISOString(),
      phase: opts.phase,
      loopId: opts.loopId,
      iteration: opts.iteration,
      promptFile: `outputs/${promptFile}`,
      responseFile: `outputs/${responseFile}`,
      costUsd: opts.costUsd,
      durationMs: opts.durationMs,
    });
  }

  logMcpToolCall(
    tool: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>
  ): void {
    this.addEvent({
      type: 'mcp_tool_call',
      timestamp: new Date().toISOString(),
      tool,
      input,
      result,
    });
  }

  logDecision(
    category: string,
    input: Record<string, unknown>,
    outcome: string,
    reason: string,
    loopId?: string
  ): void {
    this.addEvent({
      type: 'decision',
      timestamp: new Date().toISOString(),
      category,
      loopId,
      input,
      outcome,
      reason,
    });
  }

  private addEvent(event: DebugEvent): void {
    if (this.trace) {
      this.trace.events.push(event);
      // Fire and forget - save after each event for crash recovery
      // Use serialized writes to prevent file corruption
      this.writePromise = this.writePromise.then(() => this.doSaveTrace()).catch(() => {});
    }
  }

  private async saveTrace(): Promise<void> {
    // Wait for any pending writes then do a final write
    await this.writePromise;
    await this.doSaveTrace();
  }

  private async doSaveTrace(): Promise<void> {
    if (this.trace) {
      await writeFile(join(this.debugDir, 'trace.json'), JSON.stringify(this.trace, null, 2));
    }
  }
}

export function createFileTracer(stateDir: string): DebugTracer {
  return new FileTracer(stateDir);
}
