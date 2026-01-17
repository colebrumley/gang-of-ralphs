import { useApp, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { closeDatabase } from '../db/index.js';
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
}

export function App({ initialState }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const [loops, setLoops] = useState<LoopState[]>(initialState.activeLoops);
  const [running, setRunning] = useState(true);
  const stateRef = useRef(state);

  // Status area state
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState(getPhaseStatusMessage(initialState.phase));
  const [phaseOutput, setPhaseOutput] = useState<string[]>([]);

  // UI state for focused column (null = no focus, 0-3 = focused column index)
  const [focusedLoopIndex, setFocusedLoopIndex] = useState<number | null>(null);

  // Keep stateRef in sync for signal handler access
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Handle graceful shutdown on SIGINT (Ctrl+C)
  useEffect(() => {
    const handleShutdown = () => {
      // Save current state before exiting
      try {
        saveRun(stateRef.current);
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
  }, [exit]);

  useInput((input) => {
    if (input === 'q') {
      // Save state on graceful quit
      try {
        saveRun(state);
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
    // Focus on loop column 1-4 (or unfocus if same key pressed again)
    if (input >= '1' && input <= '4') {
      const index = Number.parseInt(input, 10) - 1;
      setFocusedLoopIndex((prev) => (prev === index ? null : index));
    }
  });

  const runPhase = useCallback(async () => {
    if (!running || state.phase === 'complete') return;

    const newState = await runOrchestrator(state, {
      onPhaseStart: (phase) => {
        setIsLoading(true);
        setStatusMessage(getPhaseStatusMessage(phase));
        setPhaseOutput([]);
      },
      onPhaseComplete: (_phase, success) => {
        setIsLoading(false);
        setStatusMessage(success ? 'Complete' : 'Failed');
      },
      onOutput: (text) => {
        // Stream phase output (enumerate, plan, review, etc.)
        setPhaseOutput((prev) => [...prev.slice(-9), text]);
      },
      onLoopOutput: (loopId, text) => {
        setLoops((prev) =>
          prev.map((l) =>
            l.loopId === loopId ? { ...l, output: [...l.output.slice(-99), text] } : l
          )
        );
      },
    });

    // Update status for the new phase
    setIsLoading(true);
    setStatusMessage(getPhaseStatusMessage(newState.phase));
    if (newState.phase !== state.phase) {
      setPhaseOutput([]);
    }

    setState(newState);
    setLoops(newState.activeLoops);
  }, [state, running]);

  useEffect(() => {
    if (running && state.phase !== 'complete') {
      runPhase();
    }
  }, [running, state.phase, runPhase]);

  return (
    <Layout
      state={state}
      loops={loops}
      isLoading={isLoading}
      statusMessage={statusMessage}
      phaseOutput={phaseOutput}
      focusedLoopIndex={focusedLoopIndex}
    />
  );
}
