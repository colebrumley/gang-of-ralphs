/**
 * Output message formatting utilities for the TUI.
 * Centralizes the logic for formatting and classifying different message types.
 */

/**
 * Message types that can appear in the output stream.
 */
export type OutputMessageType = 'thinking' | 'tool' | 'text';

/**
 * Format a tool start message.
 */
export function formatToolStart(toolName: string): string {
  return `[tool] starting ${toolName}\n`;
}

/**
 * Format a tool progress message with elapsed time.
 */
export function formatToolProgress(toolName: string, elapsedSeconds: number): string {
  return `[tool] ${toolName} (${elapsedSeconds.toFixed(1)}s)\n`;
}

/**
 * Format a thinking message.
 */
export function formatThinking(text: string): string {
  return `[thinking] ${text}`;
}

/**
 * Classify an output line by its type.
 */
export function classifyOutputLine(line: string): OutputMessageType {
  if (line.startsWith('[thinking]')) {
    return 'thinking';
  }
  if (line.startsWith('[tool]')) {
    return 'tool';
  }
  return 'text';
}

/**
 * Get the color for an output line based on its type.
 */
export function getOutputLineColor(line: string): string | undefined {
  const type = classifyOutputLine(line);
  switch (type) {
    case 'thinking':
      return 'magenta';
    case 'tool':
      return 'cyan';
    default:
      return undefined;
  }
}

/**
 * Determine if an output line should be dimmed.
 */
export function shouldDimOutputLine(line: string): boolean {
  const type = classifyOutputLine(line);
  // Text lines are dimmed, thinking and tool lines use their colors
  return type === 'text';
}

/**
 * Extract tool name from a tool_progress SDK message.
 */
export function extractToolProgressInfo(message: {
  tool_name?: string;
  elapsed_time_seconds?: number;
}): { toolName: string; elapsed: number } {
  return {
    toolName: message.tool_name || 'tool',
    elapsed: message.elapsed_time_seconds || 0,
  };
}

/**
 * Extract tool name from a content_block_start event for tool_use.
 */
export function extractToolStartInfo(event: {
  content_block?: { name?: string };
}): { toolName: string } {
  return {
    toolName: event.content_block?.name || 'tool',
  };
}
