import { Box, Text, useStdout } from 'ink';
import type { LoopState, OrchestratorState } from '../types/index.js';
import { Column } from './Column.js';
import { Header } from './Header.js';
import { StatusArea } from './StatusArea.js';
import { TaskPanel } from './TaskPanel.js';

interface LayoutProps {
  state: OrchestratorState;
  loops: LoopState[];
  isLoading: boolean;
  statusMessage: string;
  phaseOutput: string[];
  focusedLoopIndex: number | null;
  lastActivityTime: number;
  showTaskPanel: boolean;
  currentPage: number;
}

const MIN_COLUMN_WIDTH = 60;

export function Layout({
  state,
  loops,
  isLoading,
  statusMessage,
  phaseOutput,
  focusedLoopIndex,
  lastActivityTime,
  showTaskPanel,
  currentPage,
}: LayoutProps) {
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows || 24;
  const terminalWidth = stdout?.columns || 120;

  // Calculate how many columns can fit based on terminal width
  const maxVisibleColumns = Math.max(1, Math.floor(terminalWidth / MIN_COLUMN_WIDTH));
  const visibleColumns = Math.min(state.maxLoops, maxVisibleColumns);

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

  // Pagination calculations
  const totalLoops = Math.min(sortedLoops.length, state.maxLoops);
  const totalPages = Math.max(1, Math.ceil(totalLoops / visibleColumns));
  const safePage = Math.min(currentPage, totalPages - 1);
  const startIndex = safePage * visibleColumns;
  const endIndex = Math.min(startIndex + visibleColumns, totalLoops);
  const visibleLoops = sortedLoops.slice(startIndex, endIndex);
  const isPaginated = totalPages > 1;

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
        terminalHeight={terminalHeight}
      />

      {/* Loop columns and optional task panel */}
      <Box flexGrow={1} overflow="hidden">
        {/* Loop columns container */}
        <Box width={showTaskPanel ? '70%' : '100%'} height="100%">
          {visibleLoops.map((loop, index) => {
            const task = state.tasks.find((t) => t.id === loop.taskIds[0]);
            // focusedLoopIndex is global, convert to check if this visible column is focused
            const globalIndex = startIndex + index;
            const isFocused = focusedLoopIndex === globalIndex;
            return (
              <Column
                key={loop.loopId}
                loop={loop}
                taskTitle={task?.title || 'Unknown'}
                isFocused={isFocused}
                totalColumns={visibleColumns}
              />
            );
          })}

          {/* Empty columns if fewer visible loops than visible columns */}
          {Array.from({ length: Math.max(0, visibleColumns - visibleLoops.length) }).map((_, i) => {
            const emptyColumnWidth =
              visibleColumns === 1 ? '100%' : `${Math.floor(100 / visibleColumns)}%`;
            return (
              <Box key={`empty-${i}`} borderStyle="single" width={emptyColumnWidth} height="100%">
                <Box paddingX={1}>
                  <Text dimColor>No active loop</Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Task panel sidebar */}
        {showTaskPanel && (
          <TaskPanel
            tasks={state.tasks}
            completedTasks={state.completedTasks}
            activeLoops={loops}
          />
        )}
      </Box>

      {/* Footer */}
      <Box borderStyle="single" paddingX={1} justifyContent="space-between">
        <Text dimColor>
          [q]uit [p]ause [r]eview [t]asks [1-{visibleColumns}] focus
          {isPaginated && ' [/] page'}
        </Text>
        {isPaginated && (
          <Text dimColor>
            Page {safePage + 1}/{totalPages}
          </Text>
        )}
      </Box>
    </Box>
  );
}
