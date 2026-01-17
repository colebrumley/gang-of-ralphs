import { Box, Text } from 'ink';
import type { LoopState } from '../types/index.js';

interface ColumnProps {
  loop: LoopState;
  taskTitle: string;
}

function getStatusIndicator(status: LoopState['status']): { symbol: string; color: string } {
  switch (status) {
    case 'running':
      return { symbol: '⟳', color: 'yellow' };
    case 'completed':
      return { symbol: '✓', color: 'green' };
    case 'failed':
      return { symbol: '✗', color: 'red' };
    case 'stuck':
      return { symbol: '!', color: 'red' };
    default:
      return { symbol: '○', color: 'gray' };
  }
}

export function Column({ loop, taskTitle }: ColumnProps) {
  const status = getStatusIndicator(loop.status);
  const recentOutput = loop.output.slice(-10);

  return (
    <Box flexDirection="column" borderStyle="single" width="33%" minHeight={15}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold>{loop.loopId.slice(0, 8)}</Text>
      </Box>

      {/* Task info */}
      <Box paddingX={1}>
        <Text dimColor>task: </Text>
        <Text>{taskTitle.slice(0, 20)}</Text>
      </Box>

      {/* Status */}
      <Box paddingX={1}>
        <Text dimColor>iter: </Text>
        <Text>
          {loop.iteration}/{loop.maxIterations}
        </Text>
        <Text> </Text>
        <Text color={status.color}>{status.symbol}</Text>
        <Text> </Text>
        <Text color={status.color}>{loop.status}</Text>
      </Box>

      {/* Worktree path */}
      {loop.worktreePath && (
        <Box paddingX={1}>
          <Text dimColor>wt: {loop.worktreePath.split('/').slice(-2).join('/')}</Text>
        </Box>
      )}

      {/* Divider */}
      <Box paddingX={1}>
        <Text dimColor>{'─'.repeat(28)}</Text>
      </Box>

      {/* Output */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {recentOutput.map((line, i) => (
          <Text key={i} wrap="truncate">
            {line.slice(0, 30)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
