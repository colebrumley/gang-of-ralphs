import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { Phase } from '../types/index.js';

interface StatusAreaProps {
  phase: Phase;
  isLoading: boolean;
  statusMessage: string;
  output: string[];
  minimized?: boolean;
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
}: StatusAreaProps) {
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

      {/* Show last few lines of output */}
      {output.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {output.slice(-5).map((line, i) => (
            <Text key={i} dimColor wrap="truncate">
              {line.length > 120 ? `${line.slice(0, 117)}...` : line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
