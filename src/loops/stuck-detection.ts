import type { DebugTracer } from '../debug/index.js';
import type { LoopState } from '../types/index.js';

export enum StuckReason {
  REPEATED_ERROR = 'repeated_error',
  NO_PROGRESS = 'no_progress',
  MAX_ITERATIONS = 'max_iterations',
  IDLE_TIMEOUT = 'idle_timeout',
}

export interface StuckResult {
  reason: StuckReason;
  details: string;
  suggestion: string;
}

export interface StuckConfig {
  stuckThreshold: number;
}

export function detectStuck(
  loop: LoopState,
  config: StuckConfig,
  tracer?: DebugTracer
): StuckResult | null {
  const { stuckIndicators, iteration, maxIterations } = loop;

  // Check max iterations first
  if (iteration > maxIterations) {
    const result = {
      reason: StuckReason.MAX_ITERATIONS,
      details: `Exceeded max iterations (${maxIterations})`,
      suggestion: 'Consider breaking task into smaller pieces or increasing max iterations',
    };
    tracer?.logDecision(
      'stuck_detection',
      {
        iteration,
        maxIterations,
        sameErrorCount: stuckIndicators.sameErrorCount,
        noProgressCount: stuckIndicators.noProgressCount,
        threshold: config.stuckThreshold,
      },
      result.reason,
      result.details,
      loop.loopId
    );
    return result;
  }

  // Check repeated same error
  if (stuckIndicators.sameErrorCount >= config.stuckThreshold) {
    const result = {
      reason: StuckReason.REPEATED_ERROR,
      details: `Same error repeated ${stuckIndicators.sameErrorCount} times: ${stuckIndicators.lastError}`,
      suggestion: 'Try a different approach or provide more context',
    };
    tracer?.logDecision(
      'stuck_detection',
      {
        iteration,
        maxIterations,
        sameErrorCount: stuckIndicators.sameErrorCount,
        noProgressCount: stuckIndicators.noProgressCount,
        threshold: config.stuckThreshold,
      },
      result.reason,
      result.details,
      loop.loopId
    );
    return result;
  }

  // Check no file changes (no progress)
  const iterationsSinceChange = iteration - stuckIndicators.lastFileChangeIteration;
  if (
    stuckIndicators.noProgressCount >= config.stuckThreshold ||
    iterationsSinceChange >= config.stuckThreshold + 2
  ) {
    const result = {
      reason: StuckReason.NO_PROGRESS,
      details: `No file changes in ${iterationsSinceChange} iterations`,
      suggestion: 'Agent may be confused about the task or blocked by an issue',
    };
    tracer?.logDecision(
      'stuck_detection',
      {
        iteration,
        maxIterations,
        sameErrorCount: stuckIndicators.sameErrorCount,
        noProgressCount: stuckIndicators.noProgressCount,
        threshold: config.stuckThreshold,
      },
      result.reason,
      result.details,
      loop.loopId
    );
    return result;
  }

  // Log not stuck decision
  tracer?.logDecision(
    'stuck_detection',
    {
      iteration,
      maxIterations,
      sameErrorCount: stuckIndicators.sameErrorCount,
      noProgressCount: stuckIndicators.noProgressCount,
      threshold: config.stuckThreshold,
    },
    'not_stuck',
    'Loop is progressing normally',
    loop.loopId
  );

  return null;
}

export function updateStuckIndicators(
  loop: LoopState,
  error: string | null,
  filesChanged: boolean
): void {
  if (error) {
    if (error === loop.stuckIndicators.lastError) {
      loop.stuckIndicators.sameErrorCount++;
    } else {
      loop.stuckIndicators.sameErrorCount = 1;
      loop.stuckIndicators.lastError = error;
    }
  } else {
    loop.stuckIndicators.sameErrorCount = 0;
    loop.stuckIndicators.lastError = null;
  }

  if (filesChanged) {
    loop.stuckIndicators.lastFileChangeIteration = loop.iteration;
    loop.stuckIndicators.noProgressCount = 0;
  } else {
    loop.stuckIndicators.noProgressCount++;
  }
}
