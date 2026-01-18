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

export type LoopStatus = 'pending' | 'running' | 'stuck' | 'completed' | 'failed' | 'interrupted';

export interface LoopEvent extends TraceEvent {
  type: 'loop_created' | 'loop_iteration' | 'loop_status_change';
  loopId: string;
  taskIds: string[];
  iteration?: number;
  status?: LoopStatus;
  worktreePath?: string | null;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TaskEvent extends TraceEvent {
  type: 'task_status_change';
  taskId: string;
  previousStatus: TaskStatus;
  newStatus: TaskStatus;
  loopId?: string;
}

export interface StateSnapshotEvent extends TraceEvent {
  type: 'state_snapshot';
  trigger: 'phase_transition' | 'error' | 'run_complete';
  state: {
    phase: Phase;
    tasks: { total: number; completed: number; failed: number };
    loops: { active: number; stuck: number; completed: number };
    context: {
      discoveryCount: number;
      errorCount: number;
      decisionCount: number;
    };
    costs: {
      totalUsd: number;
      byPhase: Record<string, number>;
    };
  };
}

export interface ErrorEvent extends TraceEvent {
  type: 'error';
  error: string;
  phase: Phase;
  loopId?: string;
  context?: Record<string, unknown>;
}

export type DebugEvent =
  | PhaseStartEvent
  | PhaseCompleteEvent
  | AgentCallEvent
  | McpToolCallEvent
  | DecisionEvent
  | LoopEvent
  | TaskEvent
  | StateSnapshotEvent
  | ErrorEvent;

export interface TraceFile {
  runId: string;
  specPath: string;
  effort: string;
  startedAt: string;
  completedAt: string | null;
  events: DebugEvent[];
}

export interface AgentCallWriter {
  /** Append output as it streams in (writes immediately to response file) */
  appendOutput(text: string): void;
  /** Finalize when agent completes (writes event to trace.json) */
  complete(costUsd: number, durationMs: number): Promise<void>;
  /** Mark as interrupted if process crashes */
  markInterrupted(error?: string): Promise<void>;
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

  // New methods
  startAgentCall(opts: {
    phase: Phase;
    loopId?: string;
    iteration?: number;
    prompt: string;
  }): AgentCallWriter;

  logLoopCreated(loopId: string, taskIds: string[], worktreePath?: string | null): void;
  logLoopIteration(loopId: string, iteration: number): void;
  logLoopStatusChange(loopId: string, status: LoopStatus, taskIds: string[]): void;
  logTaskStatusChange(
    taskId: string,
    previousStatus: TaskStatus,
    newStatus: TaskStatus,
    loopId?: string
  ): void;
  logStateSnapshot(
    trigger: 'phase_transition' | 'error' | 'run_complete',
    state: StateSnapshotEvent['state']
  ): void;
  logError(error: string, phase: Phase, loopId?: string, context?: Record<string, unknown>): void;
}
