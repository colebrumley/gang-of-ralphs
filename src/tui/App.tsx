import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp, useInput } from 'ink';
import type { OrchestratorState, LoopState } from '../types/index.js';
import { runOrchestrator } from '../orchestrator/index.js';
import { saveRun } from '../state/index.js';
import { closeDatabase } from '../db/index.js';
import { Layout } from './Layout.js';

interface AppProps {
  initialState: OrchestratorState;
}

export function App({ initialState }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState(initialState);
  const [loops, setLoops] = useState<LoopState[]>(initialState.activeLoops);
  const [running, setRunning] = useState(true);
  const stateRef = useRef(state);

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
      setRunning(prev => !prev);
    }
  });

  const runPhase = useCallback(async () => {
    if (!running || state.phase === 'complete') return;

    const newState = await runOrchestrator(state, {
      onLoopOutput: (loopId, text) => {
        setLoops(prev => prev.map(l =>
          l.loopId === loopId
            ? { ...l, output: [...l.output.slice(-99), text] }
            : l
        ));
      },
    });

    setState(newState);
    setLoops(newState.activeLoops);
  }, [state, running]);

  useEffect(() => {
    if (running && state.phase !== 'complete') {
      runPhase();
    }
  }, [running, state.phase, runPhase]);

  return <Layout state={state} loops={loops} />;
}
