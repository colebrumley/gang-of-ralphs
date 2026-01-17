import assert from 'node:assert';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createFileTracer } from './file-tracer.js';
import { createNoopTracer } from './noop-tracer.js';

describe('NoopTracer', () => {
  test('all methods are callable without error', async () => {
    const tracer = createNoopTracer();

    // Should not throw
    await tracer.init('run-1', '/spec.md', 'medium');
    tracer.logPhaseStart('enumerate', {});
    tracer.logPhaseComplete('enumerate', true, 0.01, 'done');
    await tracer.logAgentCall({
      phase: 'enumerate',
      prompt: 'test',
      response: 'test',
      costUsd: 0.01,
      durationMs: 1000,
    });
    tracer.logMcpToolCall('write_task', { id: '1' }, { success: true });
    tracer.logDecision('stuck_detection', {}, 'not_stuck', 'all good');
    await tracer.finalize();

    assert.ok(true, 'All methods completed without error');
  });
});

describe('FileTracer', () => {
  const testDir = join(process.cwd(), '.sq-test-debug');

  test('creates trace file on init', async () => {
    rmSync(testDir, { recursive: true, force: true });

    const tracer = createFileTracer(testDir);
    await tracer.init('run-123', '/path/to/spec.md', 'high');

    const traceDir = join(testDir, 'debug', 'run-123');
    assert.ok(existsSync(traceDir), 'Debug directory created');
    assert.ok(existsSync(join(traceDir, 'trace.json')), 'Trace file created');

    await tracer.finalize();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('logs phase events to trace file', async () => {
    rmSync(testDir, { recursive: true, force: true });

    const tracer = createFileTracer(testDir);
    await tracer.init('run-456', '/spec.md', 'medium');

    tracer.logPhaseStart('enumerate', { tasks: [] });
    tracer.logPhaseComplete('enumerate', true, 0.05, 'Created 5 tasks');

    await tracer.finalize();

    const traceContent = await readFile(join(testDir, 'debug', 'run-456', 'trace.json'), 'utf-8');
    const trace = JSON.parse(traceContent);

    assert.strictEqual(trace.runId, 'run-456');
    assert.strictEqual(trace.events.length, 2);
    assert.strictEqual(trace.events[0].type, 'phase_start');
    assert.strictEqual(trace.events[1].type, 'phase_complete');

    rmSync(testDir, { recursive: true, force: true });
  });

  test('writes large outputs to separate files', async () => {
    rmSync(testDir, { recursive: true, force: true });

    const tracer = createFileTracer(testDir);
    await tracer.init('run-789', '/spec.md', 'low');

    const longPrompt = 'x'.repeat(10000);
    const longResponse = 'y'.repeat(10000);

    await tracer.logAgentCall({
      phase: 'enumerate',
      prompt: longPrompt,
      response: longResponse,
      costUsd: 0.02,
      durationMs: 5000,
    });

    await tracer.finalize();

    const outputsDir = join(testDir, 'debug', 'run-789', 'outputs');
    assert.ok(existsSync(outputsDir), 'Outputs directory created');

    const files = readdirSync(outputsDir);
    assert.ok(
      files.some((f) => f.includes('prompt')),
      'Prompt file created'
    );
    assert.ok(
      files.some((f) => f.includes('response')),
      'Response file created'
    );

    rmSync(testDir, { recursive: true, force: true });
  });
});
