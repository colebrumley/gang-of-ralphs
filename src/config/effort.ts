import type { EffortLevel, CostLimits } from '../types/index.js';

export interface EffortConfig {
  reviewAfterEnumerate: boolean;
  reviewAfterPlan: boolean;
  reviewInterval: number; // Review every N iterations in build loops
  reviewDepth: 'shallow' | 'standard' | 'deep' | 'comprehensive';
  stuckThreshold: number; // Same error count before flagging stuck

  // Cost limits (Risk #3 mitigation)
  costLimits: CostLimits;
}

const EFFORT_CONFIGS: Record<EffortLevel, EffortConfig> = {
  low: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: false,
    reviewInterval: 10,
    reviewDepth: 'shallow',
    stuckThreshold: 5,
    costLimits: { perLoopMaxUsd: 1.0, perPhaseMaxUsd: 2.0, perRunMaxUsd: 5.0 },
  },
  medium: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: true,
    reviewInterval: 5,
    reviewDepth: 'standard',
    stuckThreshold: 4,
    costLimits: { perLoopMaxUsd: 2.0, perPhaseMaxUsd: 5.0, perRunMaxUsd: 15.0 },
  },
  high: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 3,
    reviewDepth: 'deep',
    stuckThreshold: 3,
    costLimits: { perLoopMaxUsd: 5.0, perPhaseMaxUsd: 10.0, perRunMaxUsd: 30.0 },
  },
  max: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 1,
    reviewDepth: 'comprehensive',
    stuckThreshold: 2,
    costLimits: { perLoopMaxUsd: 10.0, perPhaseMaxUsd: 25.0, perRunMaxUsd: 100.0 },
  },
};

export function getEffortConfig(effort: EffortLevel): EffortConfig {
  return EFFORT_CONFIGS[effort];
}
