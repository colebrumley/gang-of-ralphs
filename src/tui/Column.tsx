import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { LoopState } from '../types/index.js';

interface ColumnProps {
  loop: LoopState;
  taskTitle: string;
  isFocused?: boolean;
}

function formatIdleTime(lastActivityAt: number, now: number): { text: string; color: string } {
  const idleSec = Math.floor((now - lastActivityAt) / 1000);
  if (idleSec < 30) {
    return { text: `${idleSec}s`, color: 'green' };
  }
  if (idleSec < 120) {
    return { text: `${idleSec}s`, color: 'yellow' };
  }
  const idleMin = Math.floor(idleSec / 60);
  if (idleMin < 5) {
    return { text: `${idleMin}m`, color: 'yellow' };
  }
  return { text: `${idleMin}m`, color: 'red' };
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

export function Column({ loop, taskTitle, isFocused = false }: ColumnProps) {
  const status = getStatusIndicator(loop.status);
  // Show more output when focused
  const outputLineCount = isFocused ? 20 : 10;
  const recentOutput = loop.output.slice(-outputLineCount);
  // Longer text limits when focused
  const titleLimit = isFocused ? 50 : 20;
  const outputLimit = isFocused ? 80 : 30;

  // Track current time for idle display (only update for running loops)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (loop.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loop.status]);

  const idleInfo =
    loop.status === 'running' ? formatIdleTime(loop.stuckIndicators.lastActivityAt, now) : null;

  return (
    <Box
      flexDirection="column"
      borderStyle={isFocused ? 'double' : 'single'}
      borderColor={isFocused ? 'cyan' : undefined}
      width={isFocused ? '50%' : '33%'}
      minHeight={isFocused ? 25 : 15}
    >
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color={isFocused ? 'cyan' : undefined}>
          {loop.loopId.slice(0, 8)}
        </Text>
        {isFocused && <Text dimColor> (focused)</Text>}
      </Box>

      {/* Task info */}
      <Box paddingX={1}>
        <Text dimColor>task: </Text>
        <Text>{taskTitle.slice(0, titleLimit)}</Text>
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
        {idleInfo && (
          <>
            <Text> </Text>
            <Text dimColor>idle:</Text>
            <Text color={idleInfo.color}>{idleInfo.text}</Text>
          </>
        )}
      </Box>

      {/* Worktree path */}
      {loop.worktreePath && (
        <Box paddingX={1}>
          <Text dimColor>wt: {loop.worktreePath.split('/').slice(-2).join('/')}</Text>
        </Box>
      )}

      {/* Divider */}
      <Box paddingX={1}>
        <Text dimColor>{'─'.repeat(isFocused ? 48 : 28)}</Text>
      </Box>

      {/* Output */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {recentOutput.map((line, i) => (
          <Text key={i} wrap="truncate">
            {line.slice(0, outputLimit)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
