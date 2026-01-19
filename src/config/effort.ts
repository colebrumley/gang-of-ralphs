import type { CostLimits, EffortLevel, ModelTier, Phase } from '../types/index.js';

// Model IDs for each tier
const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-20250514',
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-20250514',
};

export function getModelId(tier: ModelTier): string {
  return MODEL_IDS[tier];
}

// Phases that use models (excludes 'complete' which doesn't run an agent)
type AgentPhase = Exclude<Phase, 'complete'>;

export interface EffortConfig {
  reviewAfterEnumerate: boolean;
  reviewAfterPlan: boolean;
  reviewInterval: number; // Review every N iterations in build loops
  reviewDepth: 'shallow' | 'standard' | 'deep' | 'comprehensive';
  stuckThreshold: number; // Same error count before flagging stuck
  maxRevisions: number; // Max BUILD→REVIEW→REVISE cycles before stopping

  // Per-loop review settings
  checkpointReviewInterval: number | null; // Iterations between checkpoint reviews (null = disabled)
  maxRevisionAttempts: number; // Max revision attempts per task before marking loop stuck

  // Cost limits (Risk #3 mitigation)
  costLimits: CostLimits;

  // Model tiers per phase
  models: Record<AgentPhase, ModelTier>;
}

const EFFORT_CONFIGS: Record<EffortLevel, EffortConfig> = {
  low: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: false,
    reviewInterval: 10,
    reviewDepth: 'shallow',
    stuckThreshold: 5,
    maxRevisions: 10,
    checkpointReviewInterval: null, // No checkpoint reviews
    maxRevisionAttempts: 2,
    costLimits: { perLoopMaxUsd: 1.0, perPhaseMaxUsd: 2.0, perRunMaxUsd: 5.0 },
    models: {
      enumerate: 'haiku',
      plan: 'haiku',
      build: 'opus',
      review: 'haiku',
      revise: 'haiku',
      conflict: 'sonnet',
    },
  },
  medium: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: true,
    reviewInterval: 5,
    reviewDepth: 'standard',
    stuckThreshold: 4,
    maxRevisions: 8,
    checkpointReviewInterval: 5, // Every 5 iterations
    maxRevisionAttempts: 3,
    costLimits: { perLoopMaxUsd: 2.0, perPhaseMaxUsd: 5.0, perRunMaxUsd: 15.0 },
    models: {
      enumerate: 'sonnet',
      plan: 'sonnet',
      build: 'opus',
      review: 'sonnet',
      revise: 'sonnet',
      conflict: 'sonnet',
    },
  },
  high: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 3,
    reviewDepth: 'deep',
    stuckThreshold: 3,
    maxRevisions: 5,
    checkpointReviewInterval: 3, // Every 3 iterations
    maxRevisionAttempts: 4,
    costLimits: { perLoopMaxUsd: 5.0, perPhaseMaxUsd: 10.0, perRunMaxUsd: 30.0 },
    models: {
      enumerate: 'sonnet',
      plan: 'opus',
      build: 'opus',
      review: 'opus',
      revise: 'sonnet',
      conflict: 'opus',
    },
  },
  max: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 1,
    reviewDepth: 'comprehensive',
    stuckThreshold: 2,
    maxRevisions: 3,
    checkpointReviewInterval: 1, // Every iteration
    maxRevisionAttempts: 5,
    costLimits: { perLoopMaxUsd: 10.0, perPhaseMaxUsd: 25.0, perRunMaxUsd: 100.0 },
    models: {
      enumerate: 'opus',
      plan: 'opus',
      build: 'opus',
      review: 'opus',
      revise: 'opus',
      conflict: 'opus',
    },
  },
};

export function getEffortConfig(effort: EffortLevel): EffortConfig {
  return EFFORT_CONFIGS[effort];
}
