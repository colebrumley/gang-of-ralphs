import { resolve } from 'node:path';
import type { Phase } from '../types/index.js';

export interface MCPServerConfig {
  command: string;
  args: string[];
}

export interface AgentConfig {
  cwd: string;
  allowedTools: string[];
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  maxTurns: number;
  systemPrompt?: string;
  mcpServers?: Record<string, MCPServerConfig>;
}

const PHASE_TOOLS: Record<Phase, string[]> = {
  enumerate: ['Read', 'Glob', 'Grep'],
  plan: ['Read', 'Glob', 'Grep'],
  build: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  review: ['Read', 'Glob', 'Grep', 'Bash'],
  revise: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  complete: [],
};

const PHASE_MAX_TURNS: Record<Phase, number> = {
  enumerate: 50,
  plan: 30,
  build: 100,
  review: 50,
  revise: 100,
  complete: 1,
};

/**
 * Create agent config with optional MCP server for database access.
 * The MCP server provides tools like write_task, complete_task, etc.
 */
export function createAgentConfig(
  phase: Phase,
  cwd: string,
  runId?: string,
  dbPath?: string
): AgentConfig {
  const config: AgentConfig = {
    cwd,
    allowedTools: PHASE_TOOLS[phase],
    permissionMode: 'bypassPermissions',
    maxTurns: PHASE_MAX_TURNS[phase],
  };

  // Add MCP server for phases that write to the database
  if (runId && ['enumerate', 'plan', 'build', 'review', 'revise'].includes(phase)) {
    config.mcpServers = {
      'c2-db': {
        command: 'node',
        args: [
          resolve(cwd, 'node_modules/.bin/c2-mcp'),
          runId,
          dbPath || resolve(cwd, '.c2/state.db'),
        ],
      },
    };
  }

  return config;
}

export interface AgentMessage {
  type: 'assistant' | 'result' | 'tool';
  content?: string;
  toolName?: string;
}

export type AgentOutputHandler = (message: AgentMessage) => void;
