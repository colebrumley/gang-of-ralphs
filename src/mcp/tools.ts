import { z } from 'zod';

// Tool schemas for MCP
export const WriteTaskSchema = z.object({
  id: z.string().describe('Unique task identifier'),
  title: z.string().describe('Short task title'),
  description: z.string().describe('Detailed task description'),
  dependencies: z.array(z.string()).default([]).describe('IDs of tasks this depends on'),
  estimatedIterations: z.number().default(10).describe('Estimated iterations to complete'),
});

export const CompleteTaskSchema = z.object({
  taskId: z.string().describe('ID of task to mark complete'),
});

export const FailTaskSchema = z.object({
  taskId: z.string().describe('ID of task that failed'),
  reason: z.string().describe('Why the task failed'),
});

export const AddPlanGroupSchema = z.object({
  groupIndex: z.number().describe('Order of this group (0 = first)'),
  taskIds: z.array(z.string()).describe('Task IDs that can run in parallel'),
});

export const UpdateLoopStatusSchema = z.object({
  loopId: z.string().describe('Loop ID'),
  status: z.enum(['running', 'stuck', 'completed', 'failed']).describe('New status'),
  error: z.string().optional().describe('Error message if failed/stuck'),
});

export const RecordCostSchema = z.object({
  costUsd: z.number().describe('Cost in USD'),
  loopId: z.string().optional().describe('Loop ID if loop-specific'),
  phase: z
    .enum(['enumerate', 'plan', 'build', 'review', 'revise', 'conflict', 'complete'])
    .describe('Phase that incurred this cost'),
});

export const CreateLoopSchema = z.object({
  taskIds: z.array(z.string()).describe('Task IDs to assign to this loop'),
  maxIterations: z.number().describe('Maximum iterations before stopping'),
  reviewInterval: z.number().describe('Iterations between reviews'),
  worktreePath: z.string().optional().describe('Path to isolated worktree for this loop'),
  phase: z.string().default('build').describe('Phase that created this loop'),
});

export const PersistLoopStateSchema = z.object({
  loopId: z.string().describe('Loop ID'),
  iteration: z.number().describe('Current iteration count'),
  lastReviewAt: z.number().optional().describe('Iteration when last reviewed'),
  sameErrorCount: z.number().optional().describe('Consecutive same error count'),
  noProgressCount: z.number().optional().describe('Consecutive no progress count'),
  lastError: z.string().optional().describe('Last error message'),
  lastFileChangeIteration: z.number().optional().describe('Iteration when files last changed'),
});

export const RecordPhaseCostSchema = z.object({
  phase: z
    .enum(['enumerate', 'plan', 'build', 'review', 'revise', 'conflict', 'complete'])
    .describe('Phase that incurred this cost'),
  costUsd: z.number().describe('Cost in USD'),
});

export const SetCodebaseAnalysisSchema = z.object({
  projectType: z.string(),
  techStack: z.array(z.string()),
  directoryStructure: z.string(),
  existingFeatures: z.array(z.string()),
  entryPoints: z.array(z.string()),
  patterns: z.array(z.string()),
  summary: z.string(),
});

// Review tool schemas
export const ReviewIssueSchema = z.object({
  taskId: z.string().optional().describe('Task ID this issue relates to'),
  file: z.string().describe('File path where issue was found'),
  line: z.number().optional().describe('Line number of issue'),
  type: z
    .enum([
      'over-engineering',
      'missing-error-handling',
      'pattern-violation',
      'dead-code',
      'spec-intent-mismatch',
    ])
    .describe('Issue type'),
  description: z.string().describe('Description of the issue'),
  suggestion: z.string().describe('How to fix the issue'),
});

export const SetReviewResultSchema = z.object({
  interpretedIntent: z
    .string()
    .optional()
    .describe('What the user was actually trying to accomplish'),
  intentSatisfied: z.boolean().optional().describe('Does the implementation serve this intent?'),
  passed: z.boolean().describe('Whether the review passed'),
  issues: z.array(ReviewIssueSchema).default([]).describe('List of issues found'),
});

export const LoopReviewIssueSchema = z.object({
  file: z.string().describe('File path where issue was found'),
  line: z.number().optional().describe('Line number of issue'),
  type: z
    .enum([
      'over-engineering',
      'missing-error-handling',
      'pattern-violation',
      'dead-code',
      'spec-intent-mismatch',
    ])
    .describe('Issue type'),
  description: z.string().describe('Description of the issue'),
  suggestion: z.string().describe('How to fix the issue'),
});

export const SetLoopReviewResultSchema = z.object({
  loopId: z.string().describe('Loop ID being reviewed'),
  taskId: z.string().describe('Task ID being reviewed'),
  passed: z.boolean().describe('Whether the review passed'),
  interpretedIntent: z.string().optional().describe('What the task was trying to accomplish'),
  intentSatisfied: z.boolean().optional().describe('Does the implementation serve this intent?'),
  issues: z.array(LoopReviewIssueSchema).default([]).describe('List of issues found'),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type SetReviewResult = z.infer<typeof SetReviewResultSchema>;
export type LoopReviewIssue = z.infer<typeof LoopReviewIssueSchema>;
export type SetLoopReviewResult = z.infer<typeof SetLoopReviewResultSchema>;

export const WriteContextSchema = z.object({
  type: z
    .enum(['discovery', 'error', 'decision', 'review_issue', 'scratchpad', 'codebase_analysis'])
    .describe('The type of context being written'),
  content: z
    .string()
    .describe('The content. Plain string for simple types, JSON string for structured types'),
  task_id: z.string().optional().describe('Associated task ID'),
  loop_id: z.string().optional().describe('Associated loop ID'),
  file: z.string().optional().describe('Associated file path'),
  line: z.number().optional().describe('Associated line number'),
});

export type WriteContext = z.infer<typeof WriteContextSchema>;

export const ReadContextSchema = z.object({
  types: z.array(z.string()).optional().describe('Filter by context types'),
  task_id: z.string().optional().describe('Filter by task ID'),
  loop_id: z.string().optional().describe('Filter by loop ID'),
  file: z.string().optional().describe('Filter by file path'),
  search: z.string().optional().describe('Full-text search query'),
  limit: z.number().default(500).describe('Max entries to return'),
  offset: z.number().default(0).describe('Skip first N entries'),
  order: z.enum(['asc', 'desc']).default('desc').describe('Sort by created_at'),
});

export type ReadContext = z.infer<typeof ReadContextSchema>;

export type WriteTask = z.infer<typeof WriteTaskSchema>;
export type CompleteTask = z.infer<typeof CompleteTaskSchema>;
export type FailTask = z.infer<typeof FailTaskSchema>;
export type AddPlanGroup = z.infer<typeof AddPlanGroupSchema>;
export type UpdateLoopStatus = z.infer<typeof UpdateLoopStatusSchema>;
export type RecordCost = z.infer<typeof RecordCostSchema>;
export type CreateLoop = z.infer<typeof CreateLoopSchema>;
export type PersistLoopState = z.infer<typeof PersistLoopStateSchema>;
export type RecordPhaseCost = z.infer<typeof RecordPhaseCostSchema>;
