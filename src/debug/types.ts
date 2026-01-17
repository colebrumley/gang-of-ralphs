// src/debug/types.ts
import type { Phase } from '../types/index.js';

export interface TraceEvent {
  type: string;
  timestamp: string;
}

export interface PhaseStartEvent extends TraceEvent {
  type: 'phase_start';
  phase: Phase;
  inputState: Record<string, unknown>;
}

export interface PhaseCompleteEvent extends TraceEvent {
  type: 'phase_complete';
  phase: Phase;
  success: boolean;
  costUsd: number;
  summary: string;
}

export interface AgentCallEvent extends TraceEvent {
  type: 'agent_call';
  phase: Phase;
  loopId?: string;
  iteration?: number;
  promptFile: string;
  responseFile: string;
  costUsd: number;
  durationMs: number;
}

export interface McpToolCallEvent extends TraceEvent {
  type: 'mcp_tool_call';
  tool: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface DecisionEvent extends TraceEvent {
  type: 'decision';
  category: string;
  loopId?: string;
  input: Record<string, unknown>;
  outcome: string;
  reason: string;
}

export type DebugEvent =
  | PhaseStartEvent
  | PhaseCompleteEvent
  | AgentCallEvent
  | McpToolCallEvent
  | DecisionEvent;

export interface TraceFile {
  runId: string;
  specPath: string;
  effort: string;
  startedAt: string;
  completedAt: string | null;
  events: DebugEvent[];
}

export interface DebugTracer {
  init(runId: string, specPath: string, effort: string): Promise<void>;
  finalize(): Promise<void>;
  logPhaseStart(phase: Phase, inputState: Record<string, unknown>): void;
  logPhaseComplete(phase: Phase, success: boolean, costUsd: number, summary: string): void;
  logAgentCall(opts: {
    phase: Phase;
    loopId?: string;
    iteration?: number;
    prompt: string;
    response: string;
    costUsd: number;
    durationMs: number;
  }): Promise<void>;
  logMcpToolCall(
    tool: string,
    input: Record<string, unknown>,
    result: Record<string, unknown>
  ): void;
  logDecision(
    category: string,
    input: Record<string, unknown>,
    outcome: string,
    reason: string,
    loopId?: string
  ): void;
}
