import { resolve } from 'node:path';
import { MCP_SERVER_PATH } from '../paths.js';
import type { Phase } from '../types/index.js';

interface MCPServerConfig {
  command: string;
  args: string[];
}

interface AgentConfig {
  cwd: string;
  allowedTools: string[];
  permissionMode: 'bypassPermissions' | 'acceptEdits';
  maxTurns: number;
  systemPrompt?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  model?: string;
}

// MCP tools exposed by the sq-db server - pre-grant all permissions
const MCP_TOOLS = [
  'mcp__sq-db__write_task',
  'mcp__sq-db__complete_task',
  'mcp__sq-db__fail_task',
  'mcp__sq-db__add_plan_group',
  'mcp__sq-db__update_loop_status',
  'mcp__sq-db__record_cost',
  'mcp__sq-db__add_context',
  'mcp__sq-db__set_review_result',
  'mcp__sq-db__set_loop_review_result',
  'mcp__sq-db__create_loop',
  'mcp__sq-db__persist_loop_state',
  'mcp__sq-db__record_phase_cost',
  'mcp__sq-db__set_codebase_analysis',
];

const PHASE_TOOLS: Record<Phase, string[]> = {
  enumerate: ['Read', 'Glob', 'Grep'],
  plan: ['Read', 'Glob', 'Grep'],
  build: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  review: ['Read', 'Glob', 'Grep', 'Bash'],
  revise: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  conflict: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
  complete: [],
};

const PHASE_MAX_TURNS: Record<Phase, number> = {
  enumerate: 50,
  plan: 30,
  build: 100,
  review: 50,
  revise: 100,
  conflict: 15,
  complete: 1,
};

// Phases that have access to the MCP database server
const MCP_PHASES = ['enumerate', 'plan', 'build', 'review', 'revise'];

/**
 * Create agent config with optional MCP server for database access.
 * The MCP server provides tools like write_task, complete_task, etc.
 */
export function createAgentConfig(
  phase: Phase,
  cwd: string,
  runId?: string,
  dbPath?: string,
  model?: string
): AgentConfig {
  const usesMcp = runId && MCP_PHASES.includes(phase);

  const config: AgentConfig = {
    cwd,
    // Include MCP tools in allowedTools for phases that use MCP
    allowedTools: usesMcp ? [...PHASE_TOOLS[phase], ...MCP_TOOLS] : PHASE_TOOLS[phase],
    permissionMode: 'bypassPermissions',
    maxTurns: PHASE_MAX_TURNS[phase],
    model,
  };

  // Add MCP server for phases that write to the database
  if (usesMcp) {
    config.mcpServers = {
      'sq-db': {
        command: 'node',
        args: [MCP_SERVER_PATH, runId, dbPath || resolve(cwd, '.sq/state.db')],
      },
    };
  }

  return config;
}
