import { Box, Text, useStdout } from 'ink';
import type { LoopState, OrchestratorState } from '../types/index.js';
import { Column } from './Column.js';
import { Header } from './Header.js';
import { StatusArea } from './StatusArea.js';

interface LayoutProps {
  state: OrchestratorState;
  loops: LoopState[];
  isLoading: boolean;
  statusMessage: string;
  phaseOutput: string[];
  focusedLoopIndex: number | null;
  lastActivityTime: number;
}

export function Layout({
  state,
  loops,
  isLoading,
  statusMessage,
  phaseOutput,
  focusedLoopIndex,
  lastActivityTime,
}: LayoutProps) {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows || 24;

  const activeLoops = loops.filter((l) => l.status === 'running' || l.status === 'pending');
  // Minimize status area during build phase when loops are active
  const minimizeStatus = state.phase === 'build' && activeLoops.length > 0;

  // Sort loops to prioritize active/pending loops over completed/failed ones
  // This ensures running loops are always visible when maxLoops is limited
  const sortedLoops = [...loops].sort((a, b) => {
    const priority = (status: string) => {
      if (status === 'running') return 0;
      if (status === 'pending') return 1;
      if (status === 'stuck') return 2;
      if (status === 'failed') return 3;
      return 4; // completed
    };
    return priority(a.status) - priority(b.status);
  });

  return (
    <Box flexDirection="column" height={terminalHeight}>
      <Header
        state={state}
        activeLoopCount={activeLoops.length}
        lastActivityTime={lastActivityTime}
      />
      <StatusArea
        phase={state.phase}
        isLoading={isLoading}
        statusMessage={statusMessage}
        output={phaseOutput}
        minimized={minimizeStatus}
      />

      {/* Loop columns */}
      <Box flexGrow={1} overflow="hidden">
        {sortedLoops.slice(0, state.maxLoops).map((loop, index) => {
          const task = state.tasks.find((t) => t.id === loop.taskIds[0]);
          const isFocused = focusedLoopIndex === index;
          return (
            <Column
              key={loop.loopId}
              loop={loop}
              taskTitle={task?.title || 'Unknown'}
              isFocused={isFocused}
              totalColumns={state.maxLoops}
            />
          );
        })}

        {/* Empty columns if fewer loops than max */}
        {Array.from({ length: Math.max(0, state.maxLoops - sortedLoops.length) }).map((_, i) => {
          const emptyColumnWidth =
            state.maxLoops === 1 ? '100%' : `${Math.floor(100 / state.maxLoops)}%`;
          return (
            <Box key={`empty-${i}`} borderStyle="single" width={emptyColumnWidth} height="100%">
              <Box paddingX={1}>
                <Text dimColor>No active loop</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <Box borderStyle="single" paddingX={1}>
        <Text dimColor>[q]uit [p]ause [r]eview now [1-4] focus</Text>
      </Box>
    </Box>
  );
}
