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
});

export const AddContextSchema = z.object({
  type: z.enum(['discovery', 'error', 'decision']).describe('Type of context entry'),
  content: z.string().describe('The context content'),
});

export const ReviewIssueSchema = z.object({
  taskId: z.string().describe('ID of the task with the issue'),
  file: z.string().describe('File path where the issue was found'),
  line: z.number().optional().describe('Line number of the issue'),
  type: z.enum(['over-engineering', 'missing-error-handling', 'pattern-violation', 'dead-code']).describe('Type of issue'),
  description: z.string().describe('Description of the issue'),
  suggestion: z.string().describe('Suggested fix'),
});

export const SetReviewResultSchema = z.object({
  passed: z.boolean().describe('Whether review passed'),
  issues: z.array(ReviewIssueSchema).default([]).describe('Structured review issues found'),
});

export type WriteTask = z.infer<typeof WriteTaskSchema>;
export type CompleteTask = z.infer<typeof CompleteTaskSchema>;
export type FailTask = z.infer<typeof FailTaskSchema>;
export type AddPlanGroup = z.infer<typeof AddPlanGroupSchema>;
export type UpdateLoopStatus = z.infer<typeof UpdateLoopStatusSchema>;
export type RecordCost = z.infer<typeof RecordCostSchema>;
export type AddContext = z.infer<typeof AddContextSchema>;
export type ReviewIssueMCP = z.infer<typeof ReviewIssueSchema>;
export type SetReviewResult = z.infer<typeof SetReviewResultSchema>;
