/**
 * Tool input/output formatting utilities for the TUI.
 * Provides compact single-line summaries for tool activity display.
 */

const COMMAND_TRUNCATE_LENGTH = 40;

/**
 * Format tool input for display. Returns a compact single-line summary
 * prefixed with [tool] for TUI styling.
 */
export function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  const summary = getInputSummary(toolName, input);
  if (summary) {
    return `[tool] ${toolName} ${summary}`;
  }
  return `[tool] ${toolName}`;
}

/**
 * Format tool output for display. Returns a compact summary of the result.
 */
export function formatToolOutput(
  toolName: string,
  input: Record<string, unknown>,
  result: unknown
): string {
  return getOutputSummary(toolName, input, result);
}

/**
 * Get a compact summary of tool input based on tool type.
 */
function getInputSummary(toolName: string, input: Record<string, unknown>): string {
  // Handle MCP tools (format: server:tool_name)
  if (toolName.includes(':')) {
    return '';
  }

  switch (toolName) {
    case 'Read':
      return getFilePath(input);

    case 'Edit':
      return getFilePath(input);

    case 'Write':
      return getFilePath(input);

    case 'Bash': {
      const command = getString(input, 'command');
      if (!command) return '';
      return truncateCommand(command);
    }

    case 'Glob': {
      const pattern = getString(input, 'pattern');
      return pattern || '';
    }

    case 'Grep': {
      const pattern = getString(input, 'pattern');
      return pattern || '';
    }

    default:
      return '';
  }
}

/**
 * Get a compact summary of tool output based on tool type.
 */
function getOutputSummary(
  toolName: string,
  _input: Record<string, unknown>,
  result: unknown
): string {
  // Handle MCP tools
  if (toolName.includes(':')) {
    return formatMcpOutput(result);
  }

  switch (toolName) {
    case 'Read':
      return formatReadOutput(result);

    case 'Edit':
      return formatEditOutput(result);

    case 'Write':
      return formatWriteOutput(result);

    case 'Bash':
      return formatBashOutput(result);

    case 'Glob':
      return formatGlobOutput(result);

    case 'Grep':
      return formatGrepOutput(result);

    default:
      return '';
  }
}

/**
 * Extract file path from input, handling both file_path and path keys.
 */
function getFilePath(input: Record<string, unknown>): string {
  return getString(input, 'file_path') || getString(input, 'path') || '';
}

/**
 * Safely get a string value from input.
 */
function getString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Truncate command to fit in display, preserving readability.
 */
function truncateCommand(command: string): string {
  // Normalize whitespace (collapse newlines and multiple spaces)
  const normalized = command.replace(/\s+/g, ' ').trim();

  if (normalized.length <= COMMAND_TRUNCATE_LENGTH) {
    return normalized;
  }

  return `${normalized.substring(0, COMMAND_TRUNCATE_LENGTH - 3)}...`;
}

/**
 * Count lines in content.
 */
function countLines(content: string): number {
  if (!content) return 0;
  // Count newlines + 1 for content without trailing newline
  const lines = content.split('\n');
  // Handle trailing newline: if last element is empty, don't count it
  if (lines[lines.length - 1] === '') {
    return lines.length - 1;
  }
  return lines.length;
}

/**
 * Format Read tool output.
 */
function formatReadOutput(result: unknown): string {
  if (result === null || result === undefined) {
    return '';
  }

  // Result can be string content or object with content field
  let content: string;
  if (typeof result === 'string') {
    content = result;
  } else if (typeof result === 'object' && 'content' in result) {
    content = String((result as { content: unknown }).content);
  } else {
    return '';
  }

  const lines = countLines(content);
  return `\u2192 ${lines} line${lines !== 1 ? 's' : ''}`;
}

/**
 * Format Edit tool output.
 */
function formatEditOutput(result: unknown): string {
  // Edit typically returns success indicator or modified content
  if (result === null || result === undefined) {
    return '';
  }

  // Check for error
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (obj.error || obj.is_error || obj.isError) {
      return '\u2192 error';
    }
  }

  return '\u2192 edited';
}

/**
 * Format Write tool output.
 */
function formatWriteOutput(result: unknown): string {
  if (result === null || result === undefined) {
    return '';
  }

  // Check for error
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (obj.error || obj.is_error || obj.isError) {
      return '\u2192 error';
    }

    // Try to get line count from result
    if (typeof obj.lines === 'number') {
      const lines = obj.lines;
      return `\u2192 wrote ${lines} line${lines !== 1 ? 's' : ''}`;
    }

    // Try to count from content if available
    if (typeof obj.content === 'string') {
      const lines = countLines(obj.content);
      return `\u2192 wrote ${lines} line${lines !== 1 ? 's' : ''}`;
    }
  }

  // Default success response
  return '\u2192 wrote';
}

/**
 * Format Bash tool output.
 */
function formatBashOutput(result: unknown): string {
  if (result === null || result === undefined) {
    return '';
  }

  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;

    // Check for exit code
    if (typeof obj.exit_code === 'number') {
      return `\u2192 exit ${obj.exit_code}`;
    }

    // Check for output/stdout
    const output = obj.output ?? obj.stdout;
    if (typeof output === 'string') {
      const lines = countLines(output);
      return `\u2192 ${lines} line${lines !== 1 ? 's' : ''}`;
    }
  }

  // String result
  if (typeof result === 'string') {
    const lines = countLines(result);
    return `\u2192 ${lines} line${lines !== 1 ? 's' : ''}`;
  }

  return '';
}

/**
 * Format Glob tool output.
 */
function formatGlobOutput(result: unknown): string {
  if (result === null || result === undefined) {
    return '';
  }

  // Result is typically an array of file paths
  if (Array.isArray(result)) {
    const count = result.length;
    return `\u2192 ${count} file${count !== 1 ? 's' : ''}`;
  }

  // Could be object with files array
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.files)) {
      const count = obj.files.length;
      return `\u2192 ${count} file${count !== 1 ? 's' : ''}`;
    }
  }

  return '';
}

/**
 * Format Grep tool output.
 */
function formatGrepOutput(result: unknown): string {
  if (result === null || result === undefined) {
    return '';
  }

  // Result can be string with matches (one per line) or array
  if (typeof result === 'string') {
    // Count non-empty lines as matches
    const lines = result.split('\n').filter((line) => line.trim() !== '');
    const count = lines.length;
    return `\u2192 ${count} match${count !== 1 ? 'es' : ''}`;
  }

  if (Array.isArray(result)) {
    const count = result.length;
    return `\u2192 ${count} match${count !== 1 ? 'es' : ''}`;
  }

  // Object with matches array
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.matches)) {
      const count = obj.matches.length;
      return `\u2192 ${count} match${count !== 1 ? 'es' : ''}`;
    }
  }

  return '';
}

/**
 * Format MCP tool output (simple ok/error indicator).
 */
function formatMcpOutput(result: unknown): string {
  if (result === null || result === undefined) {
    return '\u2192 ok';
  }

  // Check for explicit error
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (obj.error || obj.is_error || obj.isError) {
      return '\u2192 error';
    }
  }

  return '\u2192 ok';
}
