import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createAgentConfig } from './spawn.js';

describe('Agent Spawning', () => {
  test('createAgentConfig returns valid config for enumerate phase', () => {
    const config = createAgentConfig('enumerate', '/path/to/project');

    assert.strictEqual(config.cwd, '/path/to/project');
    assert.ok(config.allowedTools.includes('Read'));
    assert.ok(config.allowedTools.includes('Glob'));
    assert.strictEqual(config.permissionMode, 'bypassPermissions');
  });

  test('createAgentConfig for build includes Edit and Bash', () => {
    const config = createAgentConfig('build', '/path/to/project');

    assert.ok(config.allowedTools.includes('Edit'));
    assert.ok(config.allowedTools.includes('Bash'));
  });

  test('createAgentConfig includes MCP server when runId provided', () => {
    const config = createAgentConfig('enumerate', '/path/to/project', 'test-run', '/custom/db.db');

    assert.ok(config.mcpServers);
    assert.ok('c2-db' in config.mcpServers!);
    assert.strictEqual(config.mcpServers!['c2-db'].command, 'node');
    assert.ok(config.mcpServers!['c2-db'].args.includes('test-run'));
  });

  test('createAgentConfig without runId has no MCP server', () => {
    const config = createAgentConfig('enumerate', '/path/to/project');

    assert.strictEqual(config.mcpServers, undefined);
  });

  test('complete phase has no MCP server even with runId', () => {
    const config = createAgentConfig('complete', '/path/to/project', 'test-run');

    assert.strictEqual(config.mcpServers, undefined);
  });
});
