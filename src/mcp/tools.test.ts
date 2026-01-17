import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  AddContextSchema,
  AddPlanGroupSchema,
  CompleteTaskSchema,
  CreateLoopSchema,
  FailTaskSchema,
  PersistLoopStateSchema,
  RecordCostSchema,
  RecordPhaseCostSchema,
  ReviewIssueSchema,
  SetReviewResultSchema,
  UpdateLoopStatusSchema,
  WriteTaskSchema,
} from './tools.js';

describe('MCP Tool Schemas', () => {
  describe('WriteTaskSchema', () => {
    test('accepts valid task with all fields', () => {
      const result = WriteTaskSchema.parse({
        id: 'task-1',
        title: 'Implement feature',
        description: 'Add the new feature to the API',
        dependencies: ['task-0'],
        estimatedIterations: 5,
      });

      assert.strictEqual(result.id, 'task-1');
      assert.strictEqual(result.title, 'Implement feature');
      assert.deepStrictEqual(result.dependencies, ['task-0']);
      assert.strictEqual(result.estimatedIterations, 5);
    });

    test('applies defaults for optional fields', () => {
      const result = WriteTaskSchema.parse({
        id: 'task-2',
        title: 'Simple task',
        description: 'A task without optional fields',
      });

      assert.deepStrictEqual(result.dependencies, []);
      assert.strictEqual(result.estimatedIterations, 10);
    });

    test('rejects missing required fields', () => {
      assert.throws(() => {
        WriteTaskSchema.parse({ id: 'task-3' });
      });
    });
  });

  describe('CompleteTaskSchema', () => {
    test('accepts valid taskId', () => {
      const result = CompleteTaskSchema.parse({ taskId: 'task-1' });
      assert.strictEqual(result.taskId, 'task-1');
    });

    test('rejects missing taskId', () => {
      assert.throws(() => {
        CompleteTaskSchema.parse({});
      });
    });
  });

  describe('FailTaskSchema', () => {
    test('accepts valid failure', () => {
      const result = FailTaskSchema.parse({
        taskId: 'task-1',
        reason: 'Compilation error',
      });

      assert.strictEqual(result.taskId, 'task-1');
      assert.strictEqual(result.reason, 'Compilation error');
    });

    test('rejects missing reason', () => {
      assert.throws(() => {
        FailTaskSchema.parse({ taskId: 'task-1' });
      });
    });
  });

  describe('AddPlanGroupSchema', () => {
    test('accepts valid plan group', () => {
      const result = AddPlanGroupSchema.parse({
        groupIndex: 0,
        taskIds: ['task-1', 'task-2'],
      });

      assert.strictEqual(result.groupIndex, 0);
      assert.deepStrictEqual(result.taskIds, ['task-1', 'task-2']);
    });

    test('accepts empty taskIds array', () => {
      const result = AddPlanGroupSchema.parse({
        groupIndex: 1,
        taskIds: [],
      });

      assert.deepStrictEqual(result.taskIds, []);
    });
  });

  describe('UpdateLoopStatusSchema', () => {
    test('accepts valid status update', () => {
      const result = UpdateLoopStatusSchema.parse({
        loopId: 'loop-1',
        status: 'running',
      });

      assert.strictEqual(result.loopId, 'loop-1');
      assert.strictEqual(result.status, 'running');
    });

    test('accepts status with error message', () => {
      const result = UpdateLoopStatusSchema.parse({
        loopId: 'loop-1',
        status: 'stuck',
        error: 'Same error 3 times',
      });

      assert.strictEqual(result.status, 'stuck');
      assert.strictEqual(result.error, 'Same error 3 times');
    });

    test('rejects invalid status', () => {
      assert.throws(() => {
        UpdateLoopStatusSchema.parse({
          loopId: 'loop-1',
          status: 'invalid',
        });
      });
    });

    test('accepts all valid statuses', () => {
      const statuses = ['running', 'stuck', 'completed', 'failed'];
      for (const status of statuses) {
        const result = UpdateLoopStatusSchema.parse({
          loopId: 'loop-1',
          status,
        });
        assert.strictEqual(result.status, status);
      }
    });
  });

  describe('RecordCostSchema', () => {
    test('accepts cost with all fields', () => {
      const result = RecordCostSchema.parse({
        costUsd: 0.05,
        loopId: 'loop-1',
        phase: 'build',
      });

      assert.strictEqual(result.costUsd, 0.05);
      assert.strictEqual(result.loopId, 'loop-1');
      assert.strictEqual(result.phase, 'build');
    });

    test('accepts cost without loopId', () => {
      const result = RecordCostSchema.parse({
        costUsd: 0.1,
        phase: 'enumerate',
      });

      assert.strictEqual(result.costUsd, 0.1);
      assert.strictEqual(result.loopId, undefined);
    });

    test('rejects invalid phase', () => {
      assert.throws(() => {
        RecordCostSchema.parse({
          costUsd: 0.01,
          phase: 'invalid-phase',
        });
      });
    });
  });

  describe('AddContextSchema', () => {
    test('accepts discovery context', () => {
      const result = AddContextSchema.parse({
        type: 'discovery',
        content: 'Found existing auth pattern',
      });

      assert.strictEqual(result.type, 'discovery');
      assert.strictEqual(result.content, 'Found existing auth pattern');
    });

    test('accepts error context', () => {
      const result = AddContextSchema.parse({
        type: 'error',
        content: 'Build failed: missing dependency',
      });

      assert.strictEqual(result.type, 'error');
    });

    test('accepts decision context', () => {
      const result = AddContextSchema.parse({
        type: 'decision',
        content: 'Using JWT for auth',
      });

      assert.strictEqual(result.type, 'decision');
    });

    test('rejects invalid type', () => {
      assert.throws(() => {
        AddContextSchema.parse({
          type: 'invalid',
          content: 'Something',
        });
      });
    });
  });

  describe('ReviewIssueSchema', () => {
    test('accepts valid issue with line', () => {
      const result = ReviewIssueSchema.parse({
        taskId: 'task-1',
        file: 'src/utils.ts',
        line: 42,
        type: 'over-engineering',
        description: 'Unnecessary wrapper class',
        suggestion: 'Use a plain function',
      });

      assert.strictEqual(result.file, 'src/utils.ts');
      assert.strictEqual(result.line, 42);
      assert.strictEqual(result.type, 'over-engineering');
    });

    test('accepts issue without line', () => {
      const result = ReviewIssueSchema.parse({
        taskId: 'task-1',
        file: 'src/api.ts',
        type: 'missing-error-handling',
        description: 'No try-catch',
        suggestion: 'Add error handling',
      });

      assert.strictEqual(result.line, undefined);
    });

    test('accepts all issue types', () => {
      const types = [
        'over-engineering',
        'missing-error-handling',
        'pattern-violation',
        'dead-code',
      ];
      for (const type of types) {
        const result = ReviewIssueSchema.parse({
          taskId: 'task-1',
          file: 'src/test.ts',
          type,
          description: 'Test issue',
          suggestion: 'Fix it',
        });
        assert.strictEqual(result.type, type);
      }
    });
  });

  describe('SetReviewResultSchema', () => {
    test('accepts passed review', () => {
      const result = SetReviewResultSchema.parse({
        passed: true,
        issues: [],
      });

      assert.strictEqual(result.passed, true);
      assert.deepStrictEqual(result.issues, []);
    });

    test('accepts failed review with issues', () => {
      const result = SetReviewResultSchema.parse({
        passed: false,
        issues: [
          {
            taskId: 'task-1',
            file: 'src/main.ts',
            type: 'dead-code',
            description: 'Unused import',
            suggestion: 'Remove it',
          },
        ],
      });

      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.issues.length, 1);
    });

    test('defaults issues to empty array', () => {
      const result = SetReviewResultSchema.parse({ passed: true });
      assert.deepStrictEqual(result.issues, []);
    });
  });

  describe('CreateLoopSchema', () => {
    test('accepts valid loop creation', () => {
      const result = CreateLoopSchema.parse({
        taskIds: ['task-1', 'task-2'],
        maxIterations: 20,
        reviewInterval: 5,
      });

      assert.deepStrictEqual(result.taskIds, ['task-1', 'task-2']);
      assert.strictEqual(result.maxIterations, 20);
      assert.strictEqual(result.reviewInterval, 5);
    });

    test('accepts loop with worktree', () => {
      const result = CreateLoopSchema.parse({
        taskIds: ['task-1'],
        maxIterations: 10,
        reviewInterval: 3,
        worktreePath: '/path/to/worktree',
        phase: 'build',
      });

      assert.strictEqual(result.worktreePath, '/path/to/worktree');
      assert.strictEqual(result.phase, 'build');
    });

    test('defaults phase to build', () => {
      const result = CreateLoopSchema.parse({
        taskIds: ['task-1'],
        maxIterations: 10,
        reviewInterval: 3,
      });

      assert.strictEqual(result.phase, 'build');
    });
  });

  describe('PersistLoopStateSchema', () => {
    test('accepts minimal state', () => {
      const result = PersistLoopStateSchema.parse({
        loopId: 'loop-1',
        iteration: 5,
      });

      assert.strictEqual(result.loopId, 'loop-1');
      assert.strictEqual(result.iteration, 5);
    });

    test('accepts full state', () => {
      const result = PersistLoopStateSchema.parse({
        loopId: 'loop-1',
        iteration: 10,
        lastReviewAt: 5,
        sameErrorCount: 2,
        noProgressCount: 1,
        lastError: 'Build failed',
        lastFileChangeIteration: 8,
      });

      assert.strictEqual(result.lastReviewAt, 5);
      assert.strictEqual(result.sameErrorCount, 2);
      assert.strictEqual(result.lastError, 'Build failed');
    });
  });

  describe('RecordPhaseCostSchema', () => {
    test('accepts valid phase cost', () => {
      const result = RecordPhaseCostSchema.parse({
        phase: 'build',
        costUsd: 0.25,
      });

      assert.strictEqual(result.phase, 'build');
      assert.strictEqual(result.costUsd, 0.25);
    });

    test('accepts all valid phases', () => {
      const phases = ['enumerate', 'plan', 'build', 'review', 'revise', 'conflict', 'complete'];
      for (const phase of phases) {
        const result = RecordPhaseCostSchema.parse({
          phase,
          costUsd: 0.01,
        });
        assert.strictEqual(result.phase, phase);
      }
    });

    test('rejects invalid phase', () => {
      assert.throws(() => {
        RecordPhaseCostSchema.parse({
          phase: 'invalid',
          costUsd: 0.01,
        });
      });
    });
  });
});
