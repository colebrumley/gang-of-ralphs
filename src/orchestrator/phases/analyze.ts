import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ANALYZE_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import { writeContextToDb } from '../../db/context.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { SetCodebaseAnalysisSchema } from '../../mcp/tools.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import { formatToolInput, formatToolOutput } from '../../tui/tool-formatting.js';
import type { CodebaseAnalysis, OrchestratorState } from '../../types/index.js';
import {
  type StreamEvent,
  extractInputJsonDelta,
  extractToolUseStart,
  isContentBlockStop,
  isInputJsonDelta,
  isResultMessage,
  isStreamEventMessage,
  isToolUseStart,
} from '../../types/index.js';

// Files/directories to ignore when checking if a project is empty
const IGNORED_ENTRIES = new Set([
  '.git',
  '.sq',
  '.gitignore',
  '.gitkeep',
  'node_modules',
  '.DS_Store',
]);

/**
 * Check if a directory is effectively empty (new project).
 * Returns true if directory contains only ignored files/dirs or spec files.
 */
export async function isEmptyProject(dir: string, specPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    const significantEntries = entries.filter((entry) => {
      if (IGNORED_ENTRIES.has(entry)) return false;
      const fullPath = join(dir, entry);
      if (fullPath === specPath) return false;
      if (entry.endsWith('.md')) return false;
      return true;
    });
    return significantEntries.length === 0;
  } catch (error) {
    // Log the error for debugging - readdir failures (permissions, etc.) are fail-safe
    // but should be visible for troubleshooting
    console.warn(`[analyze] isEmptyProject: failed to read directory ${dir}:`, error);
    return false;
  }
}

export interface AnalyzeResult {
  analysis: CodebaseAnalysis;
  costUsd: number;
  wasEmptyProject: boolean;
}

/**
 * Error thrown when the analyze phase agent fails to signal completion.
 */
export class AnalyzeIncompleteError extends Error {
  constructor(public readonly output: string) {
    super(
      `Analyze phase did not signal ANALYZE_COMPLETE. Agent may have crashed, timed out, or failed. For large codebases, the agent may have exhausted its 30-turn limit before completing analysis. Consider breaking the codebase into smaller sections or providing a summary file. Last output: "${output.slice(-200)}"`
    );
    this.name = 'AnalyzeIncompleteError';
  }
}

/**
 * Load codebase analysis from database after agent has written it via MCP tool.
 * First checks the unified context table, then falls back to runs table for backwards compatibility.
 */
export function loadAnalysisFromDB(runId: string): CodebaseAnalysis | null {
  const db = getDatabase();

  // First try to load from unified context table
  const contextRow = db
    .prepare(
      `SELECT content FROM context
       WHERE run_id = ? AND type = 'codebase_analysis'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(runId) as { content: string } | undefined;

  if (contextRow?.content) {
    return SetCodebaseAnalysisSchema.parse(JSON.parse(contextRow.content));
  }

  // Fall back to runs table for backwards compatibility
  const row = db.prepare('SELECT codebase_analysis FROM runs WHERE id = ?').get(runId) as
    | {
        codebase_analysis: string | null;
      }
    | undefined;

  if (!row?.codebase_analysis) {
    return null;
  }

  return SetCodebaseAnalysisSchema.parse(JSON.parse(row.codebase_analysis));
}

export async function executeAnalyze(
  state: OrchestratorState,
  onOutput?: (text: string) => void,
  tracer?: DebugTracer
): Promise<AnalyzeResult> {
  const dbPath = join(state.stateDir, 'state.db');
  const effortConfig = getEffortConfig(state.effort);
  const model = getModelId(effortConfig.models.analyze);
  const config = createAgentConfig('analyze', process.cwd(), state.runId, dbPath, model);
  const cwd = process.cwd();

  // Check if this is an empty project first
  const isEmpty = await isEmptyProject(cwd, state.specPath);

  // For empty projects, create a minimal analysis without running the agent
  if (isEmpty) {
    const emptyAnalysis: CodebaseAnalysis = {
      projectType: 'empty/greenfield',
      techStack: [],
      directoryStructure: 'Empty project - no existing structure',
      existingFeatures: [],
      entryPoints: [],
      patterns: [],
      summary: 'New project with no existing code. All functionality will be built from scratch.',
    };

    // Store in database - write to both unified context table and runs table for consistency
    const db = getDatabase();
    const analysisJson = JSON.stringify(emptyAnalysis);

    // Write to unified context table (canonical source)
    writeContextToDb(db, {
      runId: state.runId,
      type: 'codebase_analysis',
      content: analysisJson,
    });

    // Also update runs table for backwards compatibility
    db.prepare('UPDATE runs SET codebase_analysis = ? WHERE id = ?').run(analysisJson, state.runId);

    return {
      analysis: emptyAnalysis,
      costUsd: 0,
      wasEmptyProject: true,
    };
  }

  const prompt = ANALYZE_PROMPT;

  let fullOutput = '';
  let costUsd = 0;
  const startTime = Date.now();

  const writer = tracer?.startAgentCall({
    phase: 'analyze',
    prompt,
  });

  // Pending tool calls map: index -> tool info with accumulated input JSON
  const pendingToolCalls = new Map<number, { name: string; toolId: string; inputJson: string }>();
  // Completed tool calls map: toolId -> tool info with parsed input (for result formatting)
  const completedToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

  for await (const message of query({
    prompt,
    options: {
      cwd,
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      model: config.model,
      includePartialMessages: true,
      mcpServers: {
        'sq-db': {
          command: 'node',
          args: [MCP_SERVER_PATH, state.runId, dbPath],
        },
      },
    },
  })) {
    // Handle streaming events for real-time tool output and thinking
    if (isStreamEventMessage(message)) {
      const event = message.event as StreamEvent;

      // Handle tool_use content block start - store in pending map
      if (isToolUseStart(event)) {
        const toolInfo = extractToolUseStart(event);
        if (toolInfo) {
          pendingToolCalls.set(toolInfo.index, {
            name: toolInfo.toolName,
            toolId: toolInfo.toolId,
            inputJson: '',
          });
        }
      }

      // Handle input_json_delta - accumulate JSON in pending map
      if (isInputJsonDelta(event)) {
        const deltaInfo = extractInputJsonDelta(event);
        if (deltaInfo) {
          const pending = pendingToolCalls.get(deltaInfo.index);
          if (pending) {
            pending.inputJson += deltaInfo.partialJson;
          }
        }
      }

      // Handle content_block_stop - parse input, display compact summary, move to completed
      if (isContentBlockStop(event) && event.index !== undefined) {
        const pending = pendingToolCalls.get(event.index);
        if (pending) {
          // Try to parse the accumulated JSON
          let parsedInput: Record<string, unknown> = {};
          try {
            if (pending.inputJson) {
              parsedInput = JSON.parse(pending.inputJson);
            }
          } catch {
            // If JSON parsing fails, use empty object
            parsedInput = {};
          }

          // Store in completed map for result formatting
          completedToolCalls.set(pending.toolId, {
            name: pending.name,
            input: parsedInput,
          });

          // Format compact summary for output
          const toolText = formatToolInput(pending.name, parsedInput);
          onOutput?.(`${toolText}\n`);

          // Write full details to agent log
          writer?.appendOutput(`\n${toolText}\n`);
          writer?.appendOutput(`Input: ${JSON.stringify(parsedInput, null, 2)}\n`);

          // Clean up pending entry
          pendingToolCalls.delete(event.index);
        }
      }

      // Handle thinking delta events
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const thinkingText = event.delta.thinking || '';
        if (thinkingText) {
          writer?.appendOutput(thinkingText);
          onOutput?.(`[thinking] ${thinkingText}`);
        }
      }
      // Handle text delta events
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const textDelta = event.delta.text || '';
        if (textDelta) {
          fullOutput += textDelta;
          writer?.appendOutput(textDelta);
          onOutput?.(textDelta);
        }
      }
    }
    // Handle user messages with tool_result blocks to display compact output summaries
    if (message.type === 'user' && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result' &&
            'tool_use_id' in block
          ) {
            const toolUseId = block.tool_use_id as string;
            const completedTool = completedToolCalls.get(toolUseId);
            if (completedTool) {
              // Extract the result content
              let resultContent: unknown = null;
              if ('content' in block) {
                const blockContent = block.content;
                if (typeof blockContent === 'string') {
                  resultContent = blockContent;
                } else if (Array.isArray(blockContent)) {
                  const textParts = blockContent
                    .filter(
                      (c): c is { type: 'text'; text: string } =>
                        typeof c === 'object' &&
                        c !== null &&
                        'type' in c &&
                        c.type === 'text' &&
                        'text' in c
                    )
                    .map((c) => c.text);
                  resultContent = textParts.join('');
                }
              }

              // Format compact output summary
              const outputText = formatToolOutput(
                completedTool.name,
                completedTool.input,
                resultContent
              );
              if (outputText) {
                onOutput?.(`${outputText}\n`);
              }

              // Write full result to agent log
              writer?.appendOutput(`Result: ${JSON.stringify(resultContent)}\n`);

              // Clean up completed tool entry
              completedToolCalls.delete(toolUseId);
            }
          }
        }
      }
    }
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block && !fullOutput.includes(block.text)) {
          fullOutput += block.text;
          writer?.appendOutput(block.text);
          onOutput?.(block.text);
        }
        if (
          'type' in block &&
          block.type === 'thinking' &&
          'thinking' in block &&
          typeof block.thinking === 'string'
        ) {
          const thinkingText = `[thinking] ${block.thinking}\n`;
          writer?.appendOutput(thinkingText);
          onOutput?.(thinkingText);
        }
      }
    }
    if (isResultMessage(message)) {
      costUsd = message.total_cost_usd || 0;
    }
  }

  const durationMs = Date.now() - startTime;
  await writer?.complete(costUsd, durationMs);

  // Validate completion signal
  if (!fullOutput.includes('ANALYZE_COMPLETE')) {
    throw new AnalyzeIncompleteError(fullOutput);
  }

  // Load analysis from database
  const analysis = loadAnalysisFromDB(state.runId);
  if (!analysis) {
    throw new Error('Analyze phase completed but no analysis was stored');
  }

  return {
    analysis,
    costUsd,
    wasEmptyProject: false,
  };
}
