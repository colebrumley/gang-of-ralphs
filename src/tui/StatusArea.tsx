import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { Phase } from '../types/index.js';
import { getOutputLineColor, shouldDimOutputLine } from './output-formatting.js';

interface StatusAreaProps {
  phase: Phase;
  isLoading: boolean;
  statusMessage: string;
  output: string[];
  minimized?: boolean;
  terminalHeight?: number;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

function getPhaseColor(phase: Phase): string {
  switch (phase) {
    case 'enumerate':
      return 'blue';
    case 'plan':
      return 'magenta';
    case 'build':
      return 'green';
    case 'review':
      return 'yellow';
    case 'revise':
      return 'red';
    case 'conflict':
      return 'red';
    case 'complete':
      return 'green';
    default:
      return 'white';
  }
}

export function StatusArea({
  phase,
  isLoading,
  statusMessage,
  output,
  minimized,
  terminalHeight,
}: StatusAreaProps) {
  // Single-loop phases (enumerate, plan) expand to fill available space
  const isSingleLoopPhase = phase === 'enumerate' || phase === 'plan';
  // Calculate available lines: terminal height minus header (1), footer (3), status header (2), borders/padding (4)
  const availableLines = isSingleLoopPhase && terminalHeight ? Math.max(5, terminalHeight - 10) : 5;
  // In minimized mode (during build), show just a compact status line
  if (minimized) {
    return (
      <Box paddingX={1} marginBottom={1}>
        {isLoading && (
          <>
            <Spinner />
            <Text> </Text>
          </>
        )}
        <Text color={getPhaseColor(phase)} bold>
          {phase}
        </Text>
        {statusMessage && (
          <>
            <Text dimColor> - </Text>
            <Text dimColor>{statusMessage}</Text>
          </>
        )}
      </Box>
    );
  }

  // Full mode: show phase, status, and streaming output
  return (
    <Box flexDirection="column" borderStyle="round" marginBottom={1} paddingX={1}>
      <Box>
        {isLoading && (
          <>
            <Spinner />
            <Text> </Text>
          </>
        )}
        <Text color={getPhaseColor(phase)} bold>
          {phase}
        </Text>
        {statusMessage && (
          <>
            <Text> - </Text>
            <Text>{statusMessage}</Text>
          </>
        )}
      </Box>

      {/* Show output lines - expanded for single-loop phases */}
      {output.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {output.slice(-availableLines).map((line, i) => {
            const displayLine = line.length > 120 ? `${line.slice(0, 117)}...` : line;
            return (
              <Text
                key={i}
                color={getOutputLineColor(line)}
                dimColor={shouldDimOutputLine(line)}
                wrap="truncate"
              >
                {displayLine}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
