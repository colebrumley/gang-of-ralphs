import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { OrchestratorState } from '../types/index.js';

interface ActivityIndicatorProps {
  lastActivityTime: number;
}

function ActivityIndicator({ lastActivityTime }: ActivityIndicatorProps) {
  const [now, setNow] = useState(Date.now());

  // Update every second to keep the relative time fresh
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - lastActivityTime) / 1000));
  const color = elapsed < 10 ? 'green' : elapsed < 30 ? 'yellow' : 'red';
  const dot = elapsed < 10 ? '●' : '○';

  return (
    <Text color={color}>
      {dot} {elapsed}s
    </Text>
  );
}

interface HeaderProps {
  state: OrchestratorState;
  activeLoopCount: number;
  lastActivityTime: number;
}

export function Header({ state, activeLoopCount, lastActivityTime }: HeaderProps) {
  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold>Claude Squad</Text>
        <Text> | </Text>
        <Text>phase: </Text>
        <Text color="cyan">{state.phase}</Text>
        <Text> | </Text>
        <Text>effort: </Text>
        <Text color="yellow">{state.effort}</Text>
        <Text> | </Text>
        <Text>loops: </Text>
        <Text color="green">
          {activeLoopCount}/{state.maxLoops}
        </Text>
        <Text> | </Text>
        <Text>tasks: </Text>
        <Text color="green">{state.tasks.filter((t) => t.status === 'completed').length}✓</Text>
        <Text> </Text>
        <Text color="cyan">{state.tasks.filter((t) => t.status === 'in_progress').length}⟳</Text>
        <Text> </Text>
        <Text color="gray">{state.tasks.filter((t) => t.status === 'pending').length}○</Text>
        {state.tasks.some((t) => t.status === 'failed') && (
          <>
            <Text> </Text>
            <Text color="red">{state.tasks.filter((t) => t.status === 'failed').length}✗</Text>
          </>
        )}
      </Box>
      <ActivityIndicator lastActivityTime={lastActivityTime} />
    </Box>
  );
}
