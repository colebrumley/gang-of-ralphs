#!/usr/bin/env node
import { createDatabase } from '../db/index.js';
import { startMCPServer } from './server.js';

// MCP server is started with run ID as argument
const runId = process.argv[2];
const dbPath = process.argv[3] || '.c2/state.db';

if (!runId) {
  console.error('Usage: c2-mcp <run-id> [db-path]');
  process.exit(1);
}

createDatabase(dbPath);
startMCPServer(runId).catch(console.error);
