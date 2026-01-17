import { Box, Text } from 'ink';
import type { OrchestratorState } from '../types/index.js';

interface HeaderProps {
  state: OrchestratorState;
  activeLoopCount: number;
}

export function Header({ state, activeLoopCount }: HeaderProps) {
  return (
    <Box borderStyle="single" paddingX={1}>
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
      <Text color="magenta">
        {state.completedTasks.length}/{state.tasks.length}
      </Text>
    </Box>
  );
}
