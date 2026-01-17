import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  dependencies: z.array(z.string()),
  estimatedIterations: z.number(),
  assignedLoopId: z.string().nullable(),
});

export const TaskGraphSchema = z.object({
  tasks: z.array(TaskSchema),
  parallelGroups: z.array(z.array(z.string())),
});

export const StuckIndicatorsSchema = z.object({
  sameErrorCount: z.number(),
  noProgressCount: z.number(),
  lastError: z.string().nullable(),
  lastFileChangeIteration: z.number(),
});

export const LoopStateSchema = z.object({
  loopId: z.string(),
  taskIds: z.array(z.string()),
  iteration: z.number(),
  maxIterations: z.number(),
  reviewInterval: z.number(),
  lastReviewAt: z.number(),
  status: z.enum(['pending', 'running', 'stuck', 'completed', 'failed']),
  stuckIndicators: StuckIndicatorsSchema,
  output: z.array(z.string()),
});

export const OrchestratorStateSchema = z.object({
  runId: z.string(),
  specPath: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'max']),
  phase: z.enum(['enumerate', 'plan', 'build', 'review', 'revise', 'complete']),
  phaseHistory: z.array(z.object({
    phase: z.enum(['enumerate', 'plan', 'build', 'review', 'revise', 'complete']),
    success: z.boolean(),
    timestamp: z.string(),
    summary: z.string(),
  })),
  tasks: z.array(TaskSchema),
  taskGraph: TaskGraphSchema.nullable(),
  activeLoops: z.array(LoopStateSchema),
  completedTasks: z.array(z.string()),
  pendingReview: z.boolean(),
  reviewType: z.enum(['enumerate', 'plan', 'build']).nullable(),
  revisionCount: z.number(),
  context: z.object({
    discoveries: z.array(z.string()),
    errors: z.array(z.string()),
    decisions: z.array(z.string()),
  }),
  maxLoops: z.number(),
  maxIterations: z.number(),
  stateDir: z.string(),
});
