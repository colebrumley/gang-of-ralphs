import assert from 'node:assert';
import { describe, test } from 'node:test';
import { formatToolInput, formatToolOutput } from './tool-formatting.js';

describe('Tool Formatting Utilities', () => {
  describe('formatToolInput', () => {
    describe('Read tool', () => {
      test('formats file path', () => {
        assert.strictEqual(
          formatToolInput('Read', { file_path: 'src/index.ts' }),
          '[tool] Read src/index.ts'
        );
      });

      test('handles path key alternative', () => {
        assert.strictEqual(
          formatToolInput('Read', { path: '/absolute/path/file.ts' }),
          '[tool] Read /absolute/path/file.ts'
        );
      });

      test('handles missing path', () => {
        assert.strictEqual(formatToolInput('Read', {}), '[tool] Read');
      });
    });

    describe('Edit tool', () => {
      test('formats file path', () => {
        assert.strictEqual(
          formatToolInput('Edit', { file_path: 'src/utils.ts' }),
          '[tool] Edit src/utils.ts'
        );
      });
    });

    describe('Write tool', () => {
      test('formats file path', () => {
        assert.strictEqual(
          formatToolInput('Write', { file_path: 'src/new-file.ts' }),
          '[tool] Write src/new-file.ts'
        );
      });
    });

    describe('Bash tool', () => {
      test('formats short command', () => {
        assert.strictEqual(
          formatToolInput('Bash', { command: 'npm install' }),
          '[tool] Bash npm install'
        );
      });

      test('truncates long command at ~40 chars', () => {
        const longCommand = 'npm install && npm test && npm run build && npm run lint';
        const result = formatToolInput('Bash', { command: longCommand });
        assert.ok(result.startsWith('[tool] Bash npm install && npm test &&'));
        assert.ok(result.endsWith('...'));
        // [tool] Bash  = 12 chars, then ~40 char command
        assert.ok(result.length <= 12 + 40 + 1); // +1 for space
      });

      test('normalizes whitespace in command', () => {
        const result = formatToolInput('Bash', { command: 'npm\n  install' });
        assert.strictEqual(result, '[tool] Bash npm install');
      });

      test('handles missing command', () => {
        assert.strictEqual(formatToolInput('Bash', {}), '[tool] Bash');
      });
    });

    describe('Glob tool', () => {
      test('formats pattern', () => {
        assert.strictEqual(formatToolInput('Glob', { pattern: '**/*.ts' }), '[tool] Glob **/*.ts');
      });

      test('handles complex patterns', () => {
        assert.strictEqual(
          formatToolInput('Glob', { pattern: 'src/**/*.{ts,tsx}' }),
          '[tool] Glob src/**/*.{ts,tsx}'
        );
      });
    });

    describe('Grep tool', () => {
      test('formats pattern', () => {
        assert.strictEqual(
          formatToolInput('Grep', { pattern: 'function\\s+\\w+' }),
          '[tool] Grep function\\s+\\w+'
        );
      });
    });

    describe('MCP tools', () => {
      test('formats without showing parameters', () => {
        assert.strictEqual(
          formatToolInput('sq-db:write_task', { id: 'task-1', title: 'Test task' }),
          '[tool] sq-db:write_task'
        );
      });

      test('handles various MCP tool names', () => {
        assert.strictEqual(
          formatToolInput('sq-db:complete_task', { taskId: 'task-1' }),
          '[tool] sq-db:complete_task'
        );
        assert.strictEqual(
          formatToolInput('sq-db:add_plan_group', { groupIndex: 0, taskIds: ['t1', 't2'] }),
          '[tool] sq-db:add_plan_group'
        );
      });
    });

    describe('Unknown tools', () => {
      test('formats tool name only', () => {
        assert.strictEqual(
          formatToolInput('CustomTool', { anyParam: 'value' }),
          '[tool] CustomTool'
        );
      });
    });
  });

  describe('formatToolOutput', () => {
    describe('Read tool', () => {
      test('formats line count for string result', () => {
        assert.strictEqual(
          formatToolOutput('Read', { file_path: 'test.ts' }, 'line1\nline2\nline3'),
          '\u2192 3 lines'
        );
      });

      test('formats single line', () => {
        assert.strictEqual(
          formatToolOutput('Read', { file_path: 'test.ts' }, 'single line'),
          '\u2192 1 line'
        );
      });

      test('formats object with content field', () => {
        assert.strictEqual(
          formatToolOutput('Read', { file_path: 'test.ts' }, { content: 'line1\nline2' }),
          '\u2192 2 lines'
        );
      });

      test('handles empty content', () => {
        assert.strictEqual(
          formatToolOutput('Read', { file_path: 'test.ts' }, ''),
          '\u2192 0 lines'
        );
      });

      test('handles null result', () => {
        assert.strictEqual(formatToolOutput('Read', { file_path: 'test.ts' }, null), '');
      });

      test('handles trailing newline correctly', () => {
        assert.strictEqual(
          formatToolOutput('Read', { file_path: 'test.ts' }, 'line1\nline2\n'),
          '\u2192 2 lines'
        );
      });
    });

    describe('Edit tool', () => {
      test('formats success', () => {
        assert.strictEqual(
          formatToolOutput('Edit', { file_path: 'test.ts' }, { success: true }),
          '\u2192 edited'
        );
      });

      test('formats error', () => {
        assert.strictEqual(
          formatToolOutput('Edit', { file_path: 'test.ts' }, { error: 'Not found' }),
          '\u2192 error'
        );
      });

      test('formats is_error flag', () => {
        assert.strictEqual(
          formatToolOutput('Edit', { file_path: 'test.ts' }, { is_error: true }),
          '\u2192 error'
        );
      });
    });

    describe('Write tool', () => {
      test('formats success with line count', () => {
        assert.strictEqual(
          formatToolOutput('Write', { file_path: 'test.ts' }, { lines: 5 }),
          '\u2192 wrote 5 lines'
        );
      });

      test('formats single line', () => {
        assert.strictEqual(
          formatToolOutput('Write', { file_path: 'test.ts' }, { lines: 1 }),
          '\u2192 wrote 1 line'
        );
      });

      test('formats success without line count', () => {
        assert.strictEqual(
          formatToolOutput('Write', { file_path: 'test.ts' }, { success: true }),
          '\u2192 wrote'
        );
      });

      test('formats error', () => {
        assert.strictEqual(
          formatToolOutput('Write', { file_path: 'test.ts' }, { error: 'Permission denied' }),
          '\u2192 error'
        );
      });
    });

    describe('Bash tool', () => {
      test('formats exit code 0', () => {
        assert.strictEqual(
          formatToolOutput('Bash', { command: 'ls' }, { exit_code: 0 }),
          '\u2192 exit 0'
        );
      });

      test('formats non-zero exit code', () => {
        assert.strictEqual(
          formatToolOutput('Bash', { command: 'false' }, { exit_code: 1 }),
          '\u2192 exit 1'
        );
      });

      test('formats output line count when no exit code', () => {
        assert.strictEqual(
          formatToolOutput('Bash', { command: 'ls' }, { output: 'file1\nfile2\nfile3' }),
          '\u2192 3 lines'
        );
      });

      test('formats stdout line count', () => {
        assert.strictEqual(
          formatToolOutput('Bash', { command: 'ls' }, { stdout: 'file1\nfile2' }),
          '\u2192 2 lines'
        );
      });

      test('formats string result', () => {
        assert.strictEqual(
          formatToolOutput('Bash', { command: 'echo hello' }, 'hello'),
          '\u2192 1 line'
        );
      });
    });

    describe('Glob tool', () => {
      test('formats file count from array', () => {
        assert.strictEqual(
          formatToolOutput('Glob', { pattern: '**/*.ts' }, ['a.ts', 'b.ts']),
          '\u2192 2 files'
        );
      });

      test('formats single file', () => {
        assert.strictEqual(
          formatToolOutput('Glob', { pattern: 'index.ts' }, ['index.ts']),
          '\u2192 1 file'
        );
      });

      test('formats zero files', () => {
        assert.strictEqual(formatToolOutput('Glob', { pattern: '*.xyz' }, []), '\u2192 0 files');
      });

      test('formats object with files array', () => {
        assert.strictEqual(
          formatToolOutput('Glob', { pattern: '**/*.ts' }, { files: ['a.ts', 'b.ts', 'c.ts'] }),
          '\u2192 3 files'
        );
      });
    });

    describe('Grep tool', () => {
      test('formats match count from string', () => {
        assert.strictEqual(
          formatToolOutput('Grep', { pattern: 'test' }, 'file1:match\nfile2:match'),
          '\u2192 2 matches'
        );
      });

      test('formats single match', () => {
        assert.strictEqual(
          formatToolOutput('Grep', { pattern: 'test' }, 'file1:match'),
          '\u2192 1 match'
        );
      });

      test('formats zero matches', () => {
        assert.strictEqual(
          formatToolOutput('Grep', { pattern: 'notfound' }, ''),
          '\u2192 0 matches'
        );
      });

      test('formats array result', () => {
        assert.strictEqual(
          formatToolOutput('Grep', { pattern: 'test' }, ['match1', 'match2', 'match3']),
          '\u2192 3 matches'
        );
      });

      test('formats object with matches array', () => {
        assert.strictEqual(
          formatToolOutput('Grep', { pattern: 'test' }, { matches: ['m1', 'm2'] }),
          '\u2192 2 matches'
        );
      });

      test('ignores empty lines in string result', () => {
        assert.strictEqual(
          formatToolOutput('Grep', { pattern: 'test' }, 'match1\n\nmatch2\n'),
          '\u2192 2 matches'
        );
      });
    });

    describe('MCP tools', () => {
      test('formats success', () => {
        assert.strictEqual(
          formatToolOutput('sq-db:write_task', { id: 'task-1' }, { success: true }),
          '\u2192 ok'
        );
      });

      test('formats null result as ok', () => {
        assert.strictEqual(
          formatToolOutput('sq-db:complete_task', { taskId: 'task-1' }, null),
          '\u2192 ok'
        );
      });

      test('formats error', () => {
        assert.strictEqual(
          formatToolOutput('sq-db:write_task', { id: 'task-1' }, { error: 'Failed' }),
          '\u2192 error'
        );
      });

      test('formats is_error flag', () => {
        assert.strictEqual(
          formatToolOutput('sq-db:write_task', { id: 'task-1' }, { is_error: true }),
          '\u2192 error'
        );
      });

      test('formats isError flag', () => {
        assert.strictEqual(
          formatToolOutput('sq-db:write_task', { id: 'task-1' }, { isError: true }),
          '\u2192 error'
        );
      });
    });

    describe('Unknown tools', () => {
      test('returns empty string', () => {
        assert.strictEqual(
          formatToolOutput('CustomTool', { param: 'value' }, { data: 'result' }),
          ''
        );
      });
    });
  });

  describe('Integration examples from spec', () => {
    test('Read input example', () => {
      assert.strictEqual(
        formatToolInput('Read', { file_path: 'src/index.ts' }),
        '[tool] Read src/index.ts'
      );
    });

    test('Bash input example', () => {
      const result = formatToolInput('Bash', { command: 'npm install && npm test' });
      assert.ok(result.startsWith('[tool] Bash npm install && npm test'));
    });

    test('Glob input example', () => {
      assert.strictEqual(formatToolInput('Glob', { pattern: '**/*.ts' }), '[tool] Glob **/*.ts');
    });

    test('MCP input example', () => {
      assert.strictEqual(
        formatToolInput('sq-db:write_task', { id: 'task-1' }),
        '[tool] sq-db:write_task'
      );
    });

    test('Read output example', () => {
      assert.strictEqual(
        formatToolOutput('Read', { file_path: 'test.ts' }, '...\n...\n...'),
        '\u2192 3 lines'
      );
    });

    test('Bash exit code output example', () => {
      assert.strictEqual(
        formatToolOutput('Bash', { command: 'npm test' }, { exit_code: 0 }),
        '\u2192 exit 0'
      );
    });

    test('Glob output example', () => {
      assert.strictEqual(
        formatToolOutput('Glob', { pattern: '**/*.ts' }, ['a.ts', 'b.ts']),
        '\u2192 2 files'
      );
    });

    test('Grep output example', () => {
      assert.strictEqual(
        formatToolOutput('Grep', { pattern: 'test' }, 'file1:match\nfile2:match'),
        '\u2192 2 matches'
      );
    });
  });
});
