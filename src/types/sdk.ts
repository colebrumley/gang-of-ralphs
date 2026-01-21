/**
 * Type definitions and type guards for Claude Agent SDK message types.
 *
 * These types provide proper TypeScript typing for messages from the SDK's query() function,
 * replacing unsafe `as any` casts throughout the codebase.
 */

import type {
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKToolProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';

// Re-export SDK types for convenience
export type { SDKMessage, SDKToolProgressMessage, SDKResultMessage, SDKPartialAssistantMessage };

/**
 * Type guard to check if a message is a tool progress message.
 * Tool progress messages contain tool_name and elapsed_time_seconds.
 */
export function isToolProgressMessage(message: SDKMessage): message is SDKToolProgressMessage {
  return message.type === 'tool_progress';
}

/**
 * Type guard to check if a message is a result message.
 * Result messages contain total_cost_usd and other completion info.
 */
export function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result';
}

/**
 * Type guard to check if a message is a stream event message.
 * Stream events contain raw message stream events from the API.
 */
export function isStreamEventMessage(message: SDKMessage): message is SDKPartialAssistantMessage {
  return message.type === 'stream_event';
}

/**
 * Stream event types that we handle in the codebase.
 * These match the Anthropic API's BetaRawMessageStreamEvent structure.
 *
 * The SDK's event type is complex and comes from the Anthropic API. Rather than
 * trying to import and use the full type (which requires additional dependencies),
 * we define a minimal interface that covers the properties we actually access.
 * All properties are optional since different event types have different shapes.
 *
 * Event types handled:
 * - content_block_start: Signals start of a content block (text, thinking, tool_use)
 * - content_block_delta: Contains incremental content (thinking, text, input_json_delta)
 * - content_block_stop: Signals end of a content block
 */
export interface StreamEvent {
  type: string;
  /**
   * Index of the content block this event relates to.
   * Used to correlate content_block_start, content_block_delta, and content_block_stop events.
   */
  index?: number;
  content_block?: {
    type: string;
    /** Tool name for tool_use content blocks */
    name?: string;
    /** Unique ID for tool_use content blocks, used to match with tool results */
    id?: string;
  };
  delta?: {
    type: string;
    /** Thinking content for thinking_delta events */
    thinking?: string;
    /** Text content for text_delta events */
    text?: string;
    /** Partial JSON string for input_json_delta events (tool input streaming) */
    partial_json?: string;
  };
}

/**
 * Type guard to check if a stream event is a content_block_start event.
 */
export function isContentBlockStart(event: StreamEvent): boolean {
  return event.type === 'content_block_start';
}

/**
 * Type guard to check if a stream event is a content_block_delta event.
 */
export function isContentBlockDelta(event: StreamEvent): boolean {
  return event.type === 'content_block_delta';
}

/**
 * Type guard to check if a stream event is a content_block_stop event.
 */
export function isContentBlockStop(event: StreamEvent): boolean {
  return event.type === 'content_block_stop';
}

/**
 * Type guard to check if a stream event is a tool_use content block start.
 * Returns true for content_block_start events where the content block type is 'tool_use'.
 */
export function isToolUseStart(event: StreamEvent): boolean {
  return event.type === 'content_block_start' && event.content_block?.type === 'tool_use';
}

/**
 * Type guard to check if a stream event contains an input_json_delta.
 * Returns true for content_block_delta events with delta type 'input_json_delta'.
 */
export function isInputJsonDelta(event: StreamEvent): boolean {
  return event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta';
}

/**
 * Helper to extract tool use info from a content_block_start event.
 * Returns null if the event is not a tool_use start event.
 */
export function extractToolUseStart(event: StreamEvent): {
  index: number;
  toolId: string;
  toolName: string;
} | null {
  if (!isToolUseStart(event)) {
    return null;
  }
  if (event.index === undefined || !event.content_block?.id || !event.content_block?.name) {
    return null;
  }
  return {
    index: event.index,
    toolId: event.content_block.id,
    toolName: event.content_block.name,
  };
}

/**
 * Helper to extract partial JSON from an input_json_delta event.
 * Returns null if the event is not an input_json_delta event.
 */
export function extractInputJsonDelta(event: StreamEvent): {
  index: number;
  partialJson: string;
} | null {
  if (!isInputJsonDelta(event)) {
    return null;
  }
  if (event.index === undefined || event.delta?.partial_json === undefined) {
    return null;
  }
  return {
    index: event.index,
    partialJson: event.delta.partial_json,
  };
}

/**
 * Helper to safely extract tool progress info from a tool progress message.
 */
export function extractToolProgress(message: SDKToolProgressMessage): {
  toolName: string;
  elapsed: number;
} {
  return {
    toolName: message.tool_name,
    elapsed: message.elapsed_time_seconds,
  };
}

/**
 * Helper to safely extract cost from a result message.
 */
export function extractCost(message: SDKResultMessage): number {
  return message.total_cost_usd;
}
