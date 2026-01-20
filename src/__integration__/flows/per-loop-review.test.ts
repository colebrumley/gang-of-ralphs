/**
 * Integration tests for per-loop review system
 *
 * These tests verify the expected behavior of the per-loop review system:
 * 1. set_loop_review_result MCP tool should create loop_reviews records
 * 2. Review issues should be stored in the unified context table with loop_id
 * 3. Failed reviews should be queryable for revision feedback
 * 4. Error handling for invalid loopId/taskId
 *
 * The per-loop review system enables immediate review after each loop completes,
 * storing results separately from run-level reviews.
 */
import assert from 'node:assert';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readContextFromDb } from '../../db/context.js';
import { closeDatabase, createDatabase, getDatabase } from '../../db/index.js';

describe('Per-Loop Review System Integration', () => {
  let tempDir: string;
  let dbPath: string;
  let runId: string;
  let loopId: string;
  let taskId: string;

  beforeEach(async () => {
    tempDir = join(
      tmpdir(),
      `sq-integration-review-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempDir, { recursive: true });
    dbPath = join(tempDir, 'state.db');
    createDatabase(dbPath);

    runId = 'test-run';
    loopId = 'test-loop-123';
    taskId = 'task-1';

    // Set up required database state
    const db = getDatabase();
    db.prepare('INSERT INTO runs (id, spec_path, effort) VALUES (?, ?, ?)').run(
      runId,
      '/path/to/spec.md',
      'medium'
    );
    db.prepare(
      'INSERT INTO tasks (id, run_id, title, description, dependencies, estimated_iterations) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(taskId, runId, 'Test Task', 'A test task', '[]', 5);
    db.prepare(
      'INSERT INTO loops (id, run_id, task_ids, max_iterations, review_interval, phase) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(loopId, runId, JSON.stringify([taskId]), 20, 5, 'build');
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('set_loop_review_result MCP Tool', () => {
    /**
     * SPEC: The set_loop_review_result tool creates a record in loop_reviews table
     * and stores any issues in the unified context table with the loop_id.
     */

    test('SPEC: passing review should create loop_reviews record with passed=1', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      // Simulate what the MCP tool does
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed, interpreted_intent, intent_satisfied)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reviewId, runId, loopId, taskId, 1, 'Complete the test task', 1);

      // Verify
      const review = db.prepare('SELECT * FROM loop_reviews WHERE id = ?').get(reviewId) as Record<
        string,
        unknown
      >;
      assert.strictEqual(review.passed, 1);
      assert.strictEqual(review.loop_id, loopId);
      assert.strictEqual(review.task_id, taskId);
      assert.strictEqual(review.interpreted_intent, 'Complete the test task');
      assert.strictEqual(review.intent_satisfied, 1);
    });

    test('SPEC: failing review should create loop_reviews record with passed=0', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed, interpreted_intent, intent_satisfied)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reviewId, runId, loopId, taskId, 0, 'Complete the test task', 0);

      const review = db.prepare('SELECT * FROM loop_reviews WHERE id = ?').get(reviewId) as Record<
        string,
        unknown
      >;
      assert.strictEqual(review.passed, 0);
      assert.strictEqual(review.intent_satisfied, 0);
    });

    test('SPEC: review issues should be stored in context table with loop_id', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      // Create review record
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run(reviewId, runId, loopId, taskId, 0);

      // Store issues in context table (as MCP tool does)
      const issue = {
        issue_type: 'over-engineering',
        description: 'Unnecessary abstraction layer',
        suggestion: 'Remove the factory pattern',
        loop_review_id: reviewId,
      };

      db.prepare(`
        INSERT INTO context (run_id, type, content, task_id, loop_id, file, line)
        VALUES (?, 'review_issue', ?, ?, ?, ?, ?)
      `).run(runId, JSON.stringify(issue), taskId, loopId, 'src/factory.ts', 42);

      // Verify via readContextFromDb
      const { entries } = readContextFromDb(db, {
        runId,
        types: ['review_issue'],
        loopId,
      });

      assert.strictEqual(entries.length, 1);
      // Note: ContextEntry uses snake_case field names
      assert.strictEqual(entries[0].loop_id, loopId);
      assert.strictEqual(entries[0].task_id, taskId);
      assert.strictEqual(entries[0].file, 'src/factory.ts');
      assert.strictEqual(entries[0].line, 42);

      const content = JSON.parse(entries[0].content);
      assert.strictEqual(content.issue_type, 'over-engineering');
      assert.strictEqual(content.loop_review_id, reviewId);
    });

    test('SPEC: multiple issues should all be stored', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run(reviewId, runId, loopId, taskId, 0);

      // Insert multiple issues
      const issues = [
        {
          issue_type: 'over-engineering',
          description: 'Too complex',
          suggestion: 'Simplify',
          file: 'src/a.ts',
          line: 10,
        },
        {
          issue_type: 'dead-code',
          description: 'Unused function',
          suggestion: 'Remove it',
          file: 'src/b.ts',
          line: 20,
        },
        {
          issue_type: 'missing-error-handling',
          description: 'No try-catch',
          suggestion: 'Add error handling',
          file: 'src/c.ts',
          line: 30,
        },
      ];

      for (const issue of issues) {
        db.prepare(`
          INSERT INTO context (run_id, type, content, task_id, loop_id, file, line)
          VALUES (?, 'review_issue', ?, ?, ?, ?, ?)
        `).run(
          runId,
          JSON.stringify({
            issue_type: issue.issue_type,
            description: issue.description,
            suggestion: issue.suggestion,
            loop_review_id: reviewId,
          }),
          taskId,
          loopId,
          issue.file,
          issue.line
        );
      }

      const { entries } = readContextFromDb(db, {
        runId,
        types: ['review_issue'],
        loopId,
      });

      assert.strictEqual(entries.length, 3);
    });

    test('SPEC: review without issues should still create loop_reviews record', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      // Passing review with no issues
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed, interpreted_intent, intent_satisfied)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(reviewId, runId, loopId, taskId, 1, 'Task completed correctly', 1);

      const review = db.prepare('SELECT * FROM loop_reviews WHERE id = ?').get(reviewId) as Record<
        string,
        unknown
      >;
      assert.ok(review, 'Review record should exist');
      assert.strictEqual(review.passed, 1);

      // No issues in context
      const { entries } = readContextFromDb(db, {
        runId,
        types: ['review_issue'],
        loopId,
      });
      assert.strictEqual(entries.length, 0);
    });
  });

  describe('Loop Review Queries', () => {
    /**
     * SPEC: Loop reviews should be queryable by loop_id to support:
     * 1. Checking if a loop needs revision
     * 2. Injecting feedback into the next iteration
     * 3. Tracking revision attempts
     */

    test('SPEC: can query all reviews for a specific loop', async () => {
      const db = getDatabase();

      // Create multiple reviews for the same loop (simulating retries)
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
          VALUES (?, ?, ?, ?, ?)
        `).run(`review-${i}`, runId, loopId, taskId, i === 2 ? 1 : 0); // Last one passes
      }

      const reviews = db
        .prepare('SELECT * FROM loop_reviews WHERE loop_id = ? ORDER BY reviewed_at')
        .all(loopId) as Array<Record<string, unknown>>;

      assert.strictEqual(reviews.length, 3);
      assert.strictEqual(reviews[0].passed, 0);
      assert.strictEqual(reviews[1].passed, 0);
      assert.strictEqual(reviews[2].passed, 1);
    });

    test('SPEC: can query latest review for a loop', async () => {
      const db = getDatabase();

      // Insert older review first
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed, reviewed_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '-1 minute'))
      `).run('review-old', runId, loopId, taskId, 0);

      // Insert newer review with current timestamp (default)
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run('review-new', runId, loopId, taskId, 1);

      const latest = db
        .prepare('SELECT * FROM loop_reviews WHERE loop_id = ? ORDER BY reviewed_at DESC LIMIT 1')
        .get(loopId) as Record<string, unknown>;

      assert.strictEqual(latest.id, 'review-new');
      assert.strictEqual(latest.passed, 1);
    });

    test('SPEC: can count revision attempts (failed reviews) for a loop', async () => {
      const db = getDatabase();

      // 2 failed reviews, then 1 pass
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run('review-1', runId, loopId, taskId, 0);
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run('review-2', runId, loopId, taskId, 0);
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run('review-3', runId, loopId, taskId, 1);

      const failedCount = db
        .prepare('SELECT COUNT(*) as count FROM loop_reviews WHERE loop_id = ? AND passed = 0')
        .get(loopId) as { count: number };

      assert.strictEqual(failedCount.count, 2);
    });
  });

  describe('Review Issues for Feedback', () => {
    /**
     * SPEC: When a loop review fails, issues should be retrievable
     * so they can be injected into the next build iteration as feedback.
     */

    test('SPEC: issues can be queried by loop_id for feedback injection', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run(reviewId, runId, loopId, taskId, 0);

      // Add issues
      db.prepare(`
        INSERT INTO context (run_id, type, content, task_id, loop_id, file, line)
        VALUES (?, 'review_issue', ?, ?, ?, ?, ?)
      `).run(
        runId,
        JSON.stringify({
          issue_type: 'pattern-violation',
          description: 'Not using dependency injection',
          suggestion: 'Use constructor injection',
          loop_review_id: reviewId,
        }),
        taskId,
        loopId,
        'src/service.ts',
        15
      );

      // Query issues for feedback (as buildPromptWithFeedback would)
      const { entries } = readContextFromDb(db, {
        runId,
        types: ['review_issue'],
        loopId,
      });

      assert.strictEqual(entries.length, 1);

      // Format as feedback (what buildPromptWithFeedback does)
      const issue = JSON.parse(entries[0].content);
      const feedback = `[${issue.issue_type}] ${entries[0].file}:${entries[0].line} - ${issue.description}. Fix: ${issue.suggestion}`;

      assert.ok(feedback.includes('pattern-violation'));
      assert.ok(feedback.includes('src/service.ts:15'));
      assert.ok(feedback.includes('constructor injection'));
    });

    test('SPEC: issues from different loops are isolated', async () => {
      const db = getDatabase();
      const loopId2 = 'test-loop-456';

      // Create second loop
      db.prepare(
        'INSERT INTO loops (id, run_id, task_ids, max_iterations, review_interval, phase) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(loopId2, runId, JSON.stringify([taskId]), 20, 5, 'build');

      // Issues for loop 1
      db.prepare(`
        INSERT INTO context (run_id, type, content, loop_id, file)
        VALUES (?, 'review_issue', ?, ?, ?)
      `).run(
        runId,
        '{"issue_type": "loop1-issue", "description": "a", "suggestion": "b"}',
        loopId,
        'loop1.ts'
      );

      // Issues for loop 2
      db.prepare(`
        INSERT INTO context (run_id, type, content, loop_id, file)
        VALUES (?, 'review_issue', ?, ?, ?)
      `).run(
        runId,
        '{"issue_type": "loop2-issue", "description": "c", "suggestion": "d"}',
        loopId2,
        'loop2.ts'
      );

      // Query loop 1 issues only
      const loop1Issues = readContextFromDb(db, {
        runId,
        types: ['review_issue'],
        loopId: loopId,
      });
      assert.strictEqual(loop1Issues.entries.length, 1);
      assert.ok(loop1Issues.entries[0].content.includes('loop1-issue'));

      // Query loop 2 issues only
      const loop2Issues = readContextFromDb(db, {
        runId,
        types: ['review_issue'],
        loopId: loopId2,
      });
      assert.strictEqual(loop2Issues.entries.length, 1);
      assert.ok(loop2Issues.entries[0].content.includes('loop2-issue'));
    });
  });

  describe('Error Handling', () => {
    /**
     * SPEC: The MCP tool should provide helpful error messages when
     * loopId or taskId don't exist, helping agents self-correct.
     */

    test('SPEC: invalid loopId should be detectable', async () => {
      const db = getDatabase();

      // Check if loop exists before inserting review
      const loopExists = db
        .prepare('SELECT id FROM loops WHERE id = ? AND run_id = ?')
        .get('nonexistent-loop', runId);

      assert.strictEqual(loopExists, undefined, 'Non-existent loop should return undefined');
    });

    test('SPEC: invalid taskId should be detectable', async () => {
      const db = getDatabase();

      const taskExists = db
        .prepare('SELECT id FROM tasks WHERE id = ? AND run_id = ?')
        .get('nonexistent-task', runId);

      assert.strictEqual(taskExists, undefined, 'Non-existent task should return undefined');
    });

    test('SPEC: available loops should be listable for error messages', async () => {
      const db = getDatabase();

      const availableLoops = db
        .prepare('SELECT id, task_ids FROM loops WHERE run_id = ?')
        .all(runId) as Array<{ id: string; task_ids: string }>;

      assert.strictEqual(availableLoops.length, 1);
      assert.strictEqual(availableLoops[0].id, loopId);
    });
  });

  describe('Intent Tracking', () => {
    /**
     * SPEC: Per-loop reviews track interpreted intent separately from run-level reviews.
     * This allows fine-grained tracking of whether each task's intent was satisfied.
     */

    test('SPEC: interpretedIntent is optional', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      // Review without interpreted intent
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed)
        VALUES (?, ?, ?, ?, ?)
      `).run(reviewId, runId, loopId, taskId, 1);

      const review = db.prepare('SELECT * FROM loop_reviews WHERE id = ?').get(reviewId) as Record<
        string,
        unknown
      >;
      assert.strictEqual(review.interpreted_intent, null);
      assert.strictEqual(review.intent_satisfied, null);
    });

    test('SPEC: intentSatisfied can be false even when passed is true', async () => {
      const db = getDatabase();
      const reviewId = crypto.randomUUID();

      // Edge case: technically passed but doesn't serve intent
      // (e.g., task completed but doesn't actually solve the problem)
      db.prepare(`
        INSERT INTO loop_reviews (id, run_id, loop_id, task_id, passed, interpreted_intent, intent_satisfied)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        reviewId,
        runId,
        loopId,
        taskId,
        1, // passed
        'User wants fast search',
        0 // but intent not satisfied
      );

      const review = db.prepare('SELECT * FROM loop_reviews WHERE id = ?').get(reviewId) as Record<
        string,
        unknown
      >;
      assert.strictEqual(review.passed, 1);
      assert.strictEqual(review.intent_satisfied, 0);
    });
  });
});
