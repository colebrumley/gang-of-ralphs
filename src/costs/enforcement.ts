import type { CostLimits, CostTracking, Phase } from '../types/index.js';

export type CostLimitType = 'run' | 'phase' | 'loop';

export interface CostExceededResult {
  exceeded: true;
  type: CostLimitType;
  current: number;
  limit: number;
  loopId?: string;
  phase?: Phase;
}

export interface CostWithinLimitResult {
  exceeded: false;
}

export type CostCheckResult = CostExceededResult | CostWithinLimitResult;

/**
 * Check if the total run cost exceeds the per-run limit.
 */
export function checkRunCostLimit(
  costs: CostTracking,
  limits: CostLimits
): CostCheckResult {
  if (costs.totalCostUsd >= limits.perRunMaxUsd) {
    return {
      exceeded: true,
      type: 'run',
      current: costs.totalCostUsd,
      limit: limits.perRunMaxUsd,
    };
  }
  return { exceeded: false };
}

/**
 * Check if a specific phase cost exceeds the per-phase limit.
 */
export function checkPhaseCostLimit(
  phase: Phase,
  costs: CostTracking,
  limits: CostLimits
): CostCheckResult {
  const phaseCost = costs.phaseCosts[phase] ?? 0;
  if (phaseCost >= limits.perPhaseMaxUsd) {
    return {
      exceeded: true,
      type: 'phase',
      current: phaseCost,
      limit: limits.perPhaseMaxUsd,
      phase,
    };
  }
  return { exceeded: false };
}

/**
 * Check if a specific loop cost exceeds the per-loop limit.
 */
export function checkLoopCostLimit(
  loopId: string,
  costs: CostTracking,
  limits: CostLimits
): CostCheckResult {
  const loopCost = costs.loopCosts[loopId] ?? 0;
  if (loopCost >= limits.perLoopMaxUsd) {
    return {
      exceeded: true,
      type: 'loop',
      current: loopCost,
      limit: limits.perLoopMaxUsd,
      loopId,
    };
  }
  return { exceeded: false };
}

/**
 * Check all cost limits at once, returning the first exceeded limit.
 */
export function checkAllCostLimits(
  costs: CostTracking,
  limits: CostLimits,
  currentPhase?: Phase,
  activeLoopIds?: string[]
): CostCheckResult {
  // Check run limit first (highest priority)
  const runCheck = checkRunCostLimit(costs, limits);
  if (runCheck.exceeded) return runCheck;

  // Check phase limit if phase specified
  if (currentPhase) {
    const phaseCheck = checkPhaseCostLimit(currentPhase, costs, limits);
    if (phaseCheck.exceeded) return phaseCheck;
  }

  // Check loop limits if loops specified
  if (activeLoopIds) {
    for (const loopId of activeLoopIds) {
      const loopCheck = checkLoopCostLimit(loopId, costs, limits);
      if (loopCheck.exceeded) return loopCheck;
    }
  }

  return { exceeded: false };
}

/**
 * Format a cost exceeded result into a human-readable error message.
 */
export function formatCostExceededError(result: CostExceededResult): string {
  const current = `$${result.current.toFixed(2)}`;
  const limit = `$${result.limit.toFixed(2)}`;

  switch (result.type) {
    case 'run':
      return `Run cost limit exceeded: ${current} >= ${limit}`;
    case 'phase':
      return `Phase '${result.phase}' cost limit exceeded: ${current} >= ${limit}`;
    case 'loop':
      return `Loop '${result.loopId}' cost limit exceeded: ${current} >= ${limit}`;
  }
}
