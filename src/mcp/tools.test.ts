import assert from 'node:assert';
import { describe, test } from 'node:test';
import {
  AddPlanGroupSchema,
  CompleteTaskSchema,
  CreateLoopSchema,
  FailTaskSchema,
  PersistLoopStateSchema,
  ReadContextSchema,
  RecordCostSchema,
  RecordPhaseCostSchema,
  UpdateLoopStatusSchema,
  WriteContextSchema,
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

  describe('WriteContextSchema', () => {
    test('accepts valid discovery context', () => {
      const result = WriteContextSchema.safeParse({
        type: 'discovery',
        content: 'Found existing auth middleware',
      });
      assert.ok(result.success);
    });

    test('accepts review_issue with all fields', () => {
      const result = WriteContextSchema.safeParse({
        type: 'review_issue',
        content: JSON.stringify({
          issue_type: 'dead-code',
          description: 'Unused',
          suggestion: 'Remove',
        }),
        task_id: 'task-1',
        file: 'src/foo.ts',
        line: 42,
      });
      assert.ok(result.success);
    });

    test('accepts scratchpad with loop_id', () => {
      const result = WriteContextSchema.safeParse({
        type: 'scratchpad',
        content: JSON.stringify({ iteration: 1, done: false }),
        loop_id: 'loop-1',
      });
      assert.ok(result.success);
    });

    test('rejects invalid type', () => {
      const result = WriteContextSchema.safeParse({
        type: 'invalid',
        content: 'test',
      });
      assert.ok(!result.success);
    });

    test('rejects missing content', () => {
      const result = WriteContextSchema.safeParse({
        type: 'discovery',
      });
      assert.ok(!result.success);
    });
  });

  describe('ReadContextSchema', () => {
    test('accepts empty object (all optional)', () => {
      const result = ReadContextSchema.safeParse({});
      assert.ok(result.success);
    });

    test('accepts types array', () => {
      const result = ReadContextSchema.safeParse({
        types: ['discovery', 'error'],
      });
      assert.ok(result.success);
    });

    test('accepts all filter options', () => {
      const result = ReadContextSchema.safeParse({
        types: ['review_issue'],
        task_id: 'task-1',
        loop_id: 'loop-1',
        file: 'src/foo.ts',
        search: 'authentication',
        limit: 100,
        offset: 10,
        order: 'asc',
      });
      assert.ok(result.success);
    });

    test('defaults limit to 500', () => {
      const result = ReadContextSchema.parse({});
      assert.strictEqual(result.limit, 500);
    });

    test('defaults order to desc', () => {
      const result = ReadContextSchema.parse({});
      assert.strictEqual(result.order, 'desc');
    });

    test('rejects invalid order', () => {
      const result = ReadContextSchema.safeParse({ order: 'invalid' });
      assert.ok(!result.success);
    });
  });
});
