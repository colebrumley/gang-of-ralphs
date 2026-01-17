import type { EffortLevel } from '../types/index.js';

export interface EffortConfig {
  reviewAfterEnumerate: boolean;
  reviewAfterPlan: boolean;
  reviewInterval: number; // Review every N iterations in build loops
  reviewDepth: 'shallow' | 'standard' | 'deep' | 'comprehensive';
  stuckThreshold: number; // Same error count before flagging stuck
}

const EFFORT_CONFIGS: Record<EffortLevel, EffortConfig> = {
  low: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: false,
    reviewInterval: 10,
    reviewDepth: 'shallow',
    stuckThreshold: 5,
  },
  medium: {
    reviewAfterEnumerate: false,
    reviewAfterPlan: true,
    reviewInterval: 5,
    reviewDepth: 'standard',
    stuckThreshold: 4,
  },
  high: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 3,
    reviewDepth: 'deep',
    stuckThreshold: 3,
  },
  max: {
    reviewAfterEnumerate: true,
    reviewAfterPlan: true,
    reviewInterval: 1,
    reviewDepth: 'comprehensive',
    stuckThreshold: 2,
  },
};

export function getEffortConfig(effort: EffortLevel): EffortConfig {
  return EFFORT_CONFIGS[effort];
}
