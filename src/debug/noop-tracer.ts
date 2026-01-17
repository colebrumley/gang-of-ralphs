import type { Phase } from '../types/index.js';
import type { DebugTracer } from './types.js';

class NoopTracer implements DebugTracer {
  async init(_runId: string, _specPath: string, _effort: string): Promise<void> {}
  async finalize(): Promise<void> {}
  logPhaseStart(_phase: Phase, _inputState: Record<string, unknown>): void {}
  logPhaseComplete(_phase: Phase, _success: boolean, _costUsd: number, _summary: string): void {}
  async logAgentCall(_opts: {
    phase: Phase;
    loopId?: string;
    iteration?: number;
    prompt: string;
    response: string;
    costUsd: number;
    durationMs: number;
  }): Promise<void> {}
  logMcpToolCall(
    _tool: string,
    _input: Record<string, unknown>,
    _result: Record<string, unknown>
  ): void {}
  logDecision(
    _category: string,
    _input: Record<string, unknown>,
    _outcome: string,
    _reason: string,
    _loopId?: string
  ): void {}
}

export function createNoopTracer(): DebugTracer {
  return new NoopTracer();
}
