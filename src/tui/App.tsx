import { useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { closeDatabase } from '../db/index.js';
import type { DebugTracer } from '../debug/index.js';
import { runOrchestrator } from '../orchestrator/index.js';
import { saveRun } from '../state/index.js';
import type { LoopState, OrchestratorState, Phase } from '../types/index.js';
import { Layout } from './Layout.js';

function getPhaseStatusMessage(phase: Phase): string {
  switch (phase) {
    case 'enumerate':
      return 'Reading spec and identifying tasks...';
    case 'plan':
      return 'Analyzing dependencies and creating execution plan...';
    case 'build':
      return 'Running parallel agents...';
    case 'review':
      return 'Reviewing work quality...';
    case 'revise':
      return 'Analyzing issues and planning fixes...';
    case 'conflict':
      return 'Resolving merge conflicts...';
    case 'complete':
      return 'All tasks complete';
    default:
      return '';
  }
}

interface AppProps {
  initialState: OrchestratorState;
  tracer?: DebugTracer;
}

export function App({ initialState, tracer }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const [loops, setLoops] = useState<LoopState[]>(initialState.activeLoops);
  const [running, setRunning] = useState(true);
  const stateRef = useRef(state);

  // Explicit trigger counter - increments after each orchestrator run to reliably
  // trigger the next iteration (fixes issue where state.phase staying 'build'
  // didn't reliably trigger re-runs via runPhase reference changes)
  const [runTrigger, setRunTrigger] = useState(0);

  // Status area state
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState(getPhaseStatusMessage(initialState.phase));
  const [phaseOutput, setPhaseOutput] = useState<string[]>([]);

  // Activity tracking for "is it stuck?" indicator
  const [lastActivityTime, setLastActivityTime] = useState<number>(Date.now());

  // Line buffers for streaming output - accumulate partial lines until newline
  const phaseLineBuffer = useRef<string>('');
  const loopLineBuffers = useRef<Map<string, string>>(new Map());

  // UI state for focused column (null = no focus, 0-3 = focused column index)
  const [focusedLoopIndex, setFocusedLoopIndex] = useState<number | null>(null);

  // UI state for task panel visibility
  const [showTaskPanel, setShowTaskPanel] = useState(false);

  // UI state for column pagination on narrow terminals
  const [currentPage, setCurrentPage] = useState(0);

  // Calculate visible columns based on terminal width (must match Layout.tsx calculation)
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 120;
  const MIN_COLUMN_WIDTH = 60;
  const maxVisibleColumns = Math.max(1, Math.floor(terminalWidth / MIN_COLUMN_WIDTH));
  const visibleColumns = Math.min(state.maxLoops, maxVisibleColumns);
  const totalLoops = Math.min(loops.length, state.maxLoops);
  const totalPages = Math.max(1, Math.ceil(totalLoops / visibleColumns));

  // Keep stateRef in sync for signal handler access
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Handle graceful shutdown on SIGINT (Ctrl+C)
  useEffect(() => {
    const handleShutdown = () => {
      // Mark running loops as interrupted and save state before exiting
      try {
        const currentState = stateRef.current;

        // Mark any running loops as interrupted for proper resume
        const updatedLoops = currentState.activeLoops.map((loop) =>
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

        const updatedState = { ...currentState, activeLoops: updatedLoops };

        // Log the interruption to trace
        tracer?.logError('Process interrupted by signal (SIGINT/SIGTERM)', currentState.phase);

        saveRun(updatedState);
        tracer?.finalize().catch(() => {});
        closeDatabase();
      } catch {
        // Ignore errors during shutdown - best effort save
      }
      exit();
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    return () => {
      process.off('SIGINT', handleShutdown);
      process.off('SIGTERM', handleShutdown);
    };
  }, [exit, tracer]);

  useInput((input) => {
    if (input === 'q') {
      // Save state on graceful quit
      try {
        saveRun(state);
        tracer?.finalize().catch(() => {});
        closeDatabase();
      } catch {
        // Ignore errors - best effort save
      }
      setRunning(false);
      exit();
    }
    if (input === 'p') {
      setRunning((prev) => !prev);
    }
    if (input === 'r') {
      // Trigger immediate review by setting pendingReview flag
      setState((prev) => ({
        ...prev,
        pendingReview: true,
        reviewType: prev.phase === 'build' ? 'build' : prev.phase === 'plan' ? 'plan' : 'enumerate',
      }));
    }
    // Focus on visible column (1-N where N is visibleColumns)
    // When already focused, any number key unfocuses
    const keyNum = Number.parseInt(input, 10);
    if (keyNum >= 1 && keyNum <= visibleColumns) {
      if (focusedLoopIndex !== null) {
        // Already focused - unfocus
        setFocusedLoopIndex(null);
      } else {
        // Not focused - focus on the selected column
        const globalIndex = currentPage * visibleColumns + (keyNum - 1);
        if (globalIndex < totalLoops) {
          setFocusedLoopIndex(globalIndex);
        }
      }
    }
    // Page navigation with wrap-around
    if (input === '[') {
      setCurrentPage((prev) => (prev === 0 ? totalPages - 1 : prev - 1));
      setFocusedLoopIndex(null); // Clear focus when changing pages
    }
    if (input === ']') {
      setCurrentPage((prev) => (prev === totalPages - 1 ? 0 : prev + 1));
      setFocusedLoopIndex(null); // Clear focus when changing pages
    }
    // Toggle task panel
    if (input === 't') {
      setShowTaskPanel((prev) => !prev);
    }
  });

  const runPhase = useCallback(async () => {
    if (!running || state.phase === 'complete') return;

    try {
      const newState = await runOrchestrator(state, {
        onPhaseStart: (phase) => {
          setIsLoading(true);
          setStatusMessage(getPhaseStatusMessage(phase));
          setPhaseOutput([]);
          // Clear line buffers when phase changes
          phaseLineBuffer.current = '';
          loopLineBuffers.current.clear();
        },
        onPhaseComplete: (_phase, success) => {
          setIsLoading(false);
          setStatusMessage(success ? 'Complete' : 'Failed');
        },
        onOutput: (text) => {
          // Stream phase output (enumerate, plan, review, etc.)
          setLastActivityTime(Date.now());
          // Buffer partial lines - only add complete lines to output
          const buffered = phaseLineBuffer.current + text;
          const lines = buffered.split('\n');
          // Last element is either empty (if text ended with \n) or a partial line
          phaseLineBuffer.current = lines.pop() || '';
          if (lines.length > 0) {
            // Buffer up to 50 lines to support expanded display in single-loop phases
            setPhaseOutput((prev) => [...prev.slice(-(50 - lines.length)), ...lines]);
          }
        },
        onLoopCreated: (loop) => {
          // Add new loop to state immediately so onLoopOutput can find it
          setLoops((prev) => {
            // Avoid duplicates in case loop was already restored
            if (prev.some((l) => l.loopId === loop.loopId)) {
              return prev;
            }
            return [...prev, loop];
          });
        },
        onLoopOutput: (loopId, text) => {
          setLastActivityTime(Date.now());
          // Buffer partial lines per loop - only add complete lines to output
          const currentBuffer = loopLineBuffers.current.get(loopId) || '';
          const buffered = currentBuffer + text;
          const lines = buffered.split('\n');
          // Last element is either empty (if text ended with \n) or a partial line
          loopLineBuffers.current.set(loopId, lines.pop() || '');
          if (lines.length > 0) {
            setLoops((prev) =>
              prev.map((l) =>
                l.loopId === loopId
                  ? { ...l, output: [...l.output.slice(-(100 - lines.length)), ...lines] }
                  : l
              )
            );
          }
        },
        onLoopStateChange: (updatedLoop) => {
          // Update loop state in real-time (for review status, revision attempts, etc.)
          setLoops((prev) =>
            prev.map((l) =>
              l.loopId === updatedLoop.loopId
                ? { ...updatedLoop, output: l.output } // Preserve TUI's buffered output
                : l
            )
          );
        },
        tracer,
      });

      // Update status for the new phase
      setIsLoading(true);
      setStatusMessage(getPhaseStatusMessage(newState.phase));
      if (newState.phase !== state.phase) {
        setPhaseOutput([]);
      }

      setState(newState);
      // Merge loop state: preserve TUI's line-buffered output, update other fields from orchestrator
      setLoops((prevLoops) =>
        newState.activeLoops.map((newLoop) => {
          const prevLoop = prevLoops.find((l) => l.loopId === newLoop.loopId);
          // Preserve TUI's buffered output if we have it, otherwise use orchestrator's
          return {
            ...newLoop,
            output: prevLoop?.output ?? newLoop.output,
          };
        })
      );

      // Save state after each phase for resume support (matches non-TUI behavior)
      saveRun(newState);

      // Trigger next iteration - this ensures the effect re-runs even when
      // state.phase stays the same (e.g., during build iterations)
      setRunTrigger((prev) => prev + 1);
    } catch (error) {
      // Log error but continue - this prevents silent hangs from unhandled exceptions
      setStatusMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
      setIsLoading(false);
      // Still trigger to allow retry/continuation
      setRunTrigger((prev) => prev + 1);
    }
  }, [state, running, tracer]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runTrigger is intentionally used instead of runPhase to reliably trigger re-runs. Depending on runPhase (a function) caused unreliable behavior where build iterations that stayed in the same phase would not trigger the next run.
  useEffect(() => {
    if (running && state.phase !== 'complete') {
      runPhase();
    }
  }, [running, state.phase, runTrigger]);

  return (
    <Layout
      state={state}
      loops={loops}
      isLoading={isLoading}
      statusMessage={statusMessage}
      phaseOutput={phaseOutput}
      focusedLoopIndex={focusedLoopIndex}
      lastActivityTime={lastActivityTime}
      showTaskPanel={showTaskPanel}
      currentPage={currentPage}
    />
  );
}
