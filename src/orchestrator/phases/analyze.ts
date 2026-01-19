import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ANALYZE_PROMPT } from '../../agents/prompts.js';
import { createAgentConfig } from '../../agents/spawn.js';
import { getEffortConfig, getModelId } from '../../config/effort.js';
import { getDatabase } from '../../db/index.js';
import type { DebugTracer } from '../../debug/index.js';
import { SetCodebaseAnalysisSchema } from '../../mcp/tools.js';
import { MCP_SERVER_PATH } from '../../paths.js';
import type { CodebaseAnalysis, OrchestratorState } from '../../types/index.js';
import {
  type StreamEvent,
  isResultMessage,
  isStreamEventMessage,
  isToolProgressMessage,
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
      if (specPath.endsWith(entry)) return false;
      if (entry.endsWith('.md')) return false;
      return true;
    });
    return significantEntries.length === 0;
  } catch {
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
      `Analyze phase did not signal ANALYZE_COMPLETE. Agent may have crashed, timed out, or failed. Last output: "${output.slice(-200)}"`
    );
    this.name = 'AnalyzeIncompleteError';
  }
}

/**
 * Load codebase analysis from database after agent has written it via MCP tool.
 */
export function loadAnalysisFromDB(runId: string): CodebaseAnalysis | null {
  const db = getDatabase();
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

    // Store in database
    const db = getDatabase();
    db.prepare('UPDATE runs SET codebase_analysis = ? WHERE id = ?').run(
      JSON.stringify(emptyAnalysis),
      state.runId
    );

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
    if (isToolProgressMessage(message)) {
      const toolName = message.tool_name || 'tool';
      const elapsed = message.elapsed_time_seconds || 0;
      const progressText = `[tool] ${toolName} (${elapsed.toFixed(1)}s)\n`;
      writer?.appendOutput(progressText);
      onOutput?.(progressText);
    }
    if (isStreamEventMessage(message)) {
      const event = message.event as StreamEvent;
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const toolName = event.content_block.name || 'tool';
        const toolText = `[tool] starting ${toolName}\n`;
        writer?.appendOutput(toolText);
        onOutput?.(toolText);
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        const thinkingText = event.delta.thinking || '';
        if (thinkingText) {
          writer?.appendOutput(thinkingText);
          onOutput?.(`[thinking] ${thinkingText}`);
        }
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const textDelta = event.delta.text || '';
        if (textDelta) {
          fullOutput += textDelta;
          writer?.appendOutput(textDelta);
          onOutput?.(textDelta);
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
