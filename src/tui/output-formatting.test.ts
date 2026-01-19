import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  classifyOutputLine,
  extractToolProgressInfo,
  extractToolStartInfo,
  formatThinking,
  formatToolProgress,
  formatToolStart,
  getOutputLineColor,
  shouldDimOutputLine,
} from './output-formatting.js';

describe('Output Formatting Utilities', () => {
  describe('formatToolStart', () => {
    test('formats tool start message with tool name', () => {
      const result = formatToolStart('Read');
      assert.strictEqual(result, '[tool] starting Read\n');
    });

    test('handles empty tool name', () => {
      const result = formatToolStart('');
      assert.strictEqual(result, '[tool] starting \n');
    });

    test('handles tool names with spaces', () => {
      const result = formatToolStart('MCP Tool');
      assert.strictEqual(result, '[tool] starting MCP Tool\n');
    });
  });

  describe('formatToolProgress', () => {
    test('formats tool progress with elapsed time', () => {
      const result = formatToolProgress('Grep', 2.5);
      assert.strictEqual(result, '[tool] Grep (2.5s)\n');
    });

    test('formats elapsed time to one decimal place', () => {
      const result = formatToolProgress('Read', 1.234);
      assert.strictEqual(result, '[tool] Read (1.2s)\n');
    });

    test('handles zero elapsed time', () => {
      const result = formatToolProgress('Glob', 0);
      assert.strictEqual(result, '[tool] Glob (0.0s)\n');
    });

    test('handles large elapsed times', () => {
      const result = formatToolProgress('Bash', 123.456);
      assert.strictEqual(result, '[tool] Bash (123.5s)\n');
    });
  });

  describe('formatThinking', () => {
    test('formats thinking message with prefix', () => {
      const result = formatThinking('Analyzing the codebase...');
      assert.strictEqual(result, '[thinking] Analyzing the codebase...');
    });

    test('handles empty thinking text', () => {
      const result = formatThinking('');
      assert.strictEqual(result, '[thinking] ');
    });

    test('handles multiline thinking text', () => {
      const result = formatThinking('Line 1\nLine 2');
      assert.strictEqual(result, '[thinking] Line 1\nLine 2');
    });
  });

  describe('classifyOutputLine', () => {
    test('classifies thinking lines', () => {
      assert.strictEqual(classifyOutputLine('[thinking] some thought'), 'thinking');
      assert.strictEqual(classifyOutputLine('[thinking]'), 'thinking');
      assert.strictEqual(classifyOutputLine('[thinking] '), 'thinking');
    });

    test('classifies tool lines', () => {
      assert.strictEqual(classifyOutputLine('[tool] starting Read'), 'tool');
      assert.strictEqual(classifyOutputLine('[tool] Grep (2.5s)'), 'tool');
      assert.strictEqual(classifyOutputLine('[tool]'), 'tool');
    });

    test('classifies regular text lines', () => {
      assert.strictEqual(classifyOutputLine('Some regular output'), 'text');
      assert.strictEqual(classifyOutputLine(''), 'text');
      assert.strictEqual(classifyOutputLine('TASK_COMPLETE'), 'text');
    });

    test('does not misclassify lines with brackets elsewhere', () => {
      assert.strictEqual(classifyOutputLine('Using [tool] in sentence'), 'text');
      assert.strictEqual(classifyOutputLine('  [thinking] with leading space'), 'text');
    });
  });

  describe('getOutputLineColor', () => {
    test('returns magenta for thinking lines', () => {
      assert.strictEqual(getOutputLineColor('[thinking] analyzing...'), 'magenta');
    });

    test('returns cyan for tool lines', () => {
      assert.strictEqual(getOutputLineColor('[tool] starting Read'), 'cyan');
      assert.strictEqual(getOutputLineColor('[tool] Grep (1.5s)'), 'cyan');
    });

    test('returns undefined for regular text', () => {
      assert.strictEqual(getOutputLineColor('Regular output'), undefined);
      assert.strictEqual(getOutputLineColor(''), undefined);
    });
  });

  describe('shouldDimOutputLine', () => {
    test('returns false for thinking lines (use color instead)', () => {
      assert.strictEqual(shouldDimOutputLine('[thinking] analyzing...'), false);
    });

    test('returns false for tool lines (use color instead)', () => {
      assert.strictEqual(shouldDimOutputLine('[tool] starting Read'), false);
    });

    test('returns true for regular text lines', () => {
      assert.strictEqual(shouldDimOutputLine('Regular output'), true);
      assert.strictEqual(shouldDimOutputLine('TASK_COMPLETE'), true);
    });
  });

  describe('extractToolProgressInfo', () => {
    test('extracts tool name and elapsed time', () => {
      const result = extractToolProgressInfo({
        tool_name: 'Read',
        elapsed_time_seconds: 2.5,
      });
      assert.deepStrictEqual(result, { toolName: 'Read', elapsed: 2.5 });
    });

    test('provides defaults for missing fields', () => {
      const result = extractToolProgressInfo({});
      assert.deepStrictEqual(result, { toolName: 'tool', elapsed: 0 });
    });

    test('handles partial data', () => {
      const result = extractToolProgressInfo({ tool_name: 'Grep' });
      assert.deepStrictEqual(result, { toolName: 'Grep', elapsed: 0 });
    });
  });

  describe('extractToolStartInfo', () => {
    test('extracts tool name from content block', () => {
      const result = extractToolStartInfo({
        content_block: { name: 'Read' },
      });
      assert.deepStrictEqual(result, { toolName: 'Read' });
    });

    test('provides default for missing content block', () => {
      const result = extractToolStartInfo({});
      assert.deepStrictEqual(result, { toolName: 'tool' });
    });

    test('provides default for missing name', () => {
      const result = extractToolStartInfo({ content_block: {} });
      assert.deepStrictEqual(result, { toolName: 'tool' });
    });
  });
});

describe('Output Line Classification Integration', () => {
  test('all line types have consistent behavior', () => {
    const lines = [
      {
        line: '[thinking] analyzing...',
        expectedType: 'thinking',
        expectedColor: 'magenta',
        expectedDim: false,
      },
      {
        line: '[tool] starting Read',
        expectedType: 'tool',
        expectedColor: 'cyan',
        expectedDim: false,
      },
      {
        line: '[tool] Read (2.5s)',
        expectedType: 'tool',
        expectedColor: 'cyan',
        expectedDim: false,
      },
      {
        line: 'Regular text output',
        expectedType: 'text',
        expectedColor: undefined,
        expectedDim: true,
      },
      { line: 'TASK_COMPLETE', expectedType: 'text', expectedColor: undefined, expectedDim: true },
      { line: '', expectedType: 'text', expectedColor: undefined, expectedDim: true },
    ];

    for (const { line, expectedType, expectedColor, expectedDim } of lines) {
      assert.strictEqual(
        classifyOutputLine(line),
        expectedType,
        `Line "${line}" should be classified as "${expectedType}"`
      );
      assert.strictEqual(
        getOutputLineColor(line),
        expectedColor,
        `Line "${line}" should have color "${expectedColor}"`
      );
      assert.strictEqual(
        shouldDimOutputLine(line),
        expectedDim,
        `Line "${line}" dimmed should be ${expectedDim}`
      );
    }
  });

  test('formatted messages are correctly classified', () => {
    // Tool start messages
    const toolStart = formatToolStart('Read');
    assert.strictEqual(classifyOutputLine(toolStart.trim()), 'tool');

    // Tool progress messages
    const toolProgress = formatToolProgress('Grep', 1.5);
    assert.strictEqual(classifyOutputLine(toolProgress.trim()), 'tool');

    // Thinking messages
    const thinking = formatThinking('analyzing...');
    assert.strictEqual(classifyOutputLine(thinking), 'thinking');
  });
});
