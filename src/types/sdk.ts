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
 */
export interface StreamEvent {
  type: string;
  content_block?: {
    type: string;
    name?: string;
  };
  delta?: {
    type: string;
    thinking?: string;
    text?: string;
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
