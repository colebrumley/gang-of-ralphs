import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { CostLimits, CostTracking } from '../types/index.js';
import {
  checkAllCostLimits,
  checkLoopCostLimit,
  checkPhaseCostLimit,
  checkRunCostLimit,
  formatCostExceededError,
} from './enforcement.js';

describe('cost enforcement', () => {
  const defaultLimits: CostLimits = {
    perLoopMaxUsd: 1.0,
    perPhaseMaxUsd: 2.0,
    perRunMaxUsd: 5.0,
  };

  const defaultCosts: CostTracking = {
    totalCostUsd: 0,
    phaseCosts: {
      enumerate: 0,
      plan: 0,
      build: 0,
      review: 0,
      revise: 0,
      conflict: 0,
      complete: 0,
    },
    loopCosts: {},
  };

  describe('checkRunCostLimit', () => {
    it('returns exceeded=false when cost is below limit', () => {
      const costs: CostTracking = { ...defaultCosts, totalCostUsd: 4.99 };
      const result = checkRunCostLimit(costs, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });

    it('returns exceeded=false when cost equals limit', () => {
      const costs: CostTracking = { ...defaultCosts, totalCostUsd: 5.0 };
      const result = checkRunCostLimit(costs, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });

    it('returns exceeded=true when cost exceeds limit', () => {
      const costs: CostTracking = { ...defaultCosts, totalCostUsd: 10.0 };
      const result = checkRunCostLimit(costs, defaultLimits);
      assert.strictEqual(result.exceeded, true);
      if (result.exceeded) {
        assert.strictEqual(result.type, 'run');
        assert.strictEqual(result.current, 10.0);
        assert.strictEqual(result.limit, 5.0);
      }
    });
  });

  describe('checkPhaseCostLimit', () => {
    it('returns exceeded=false when phase cost is below limit', () => {
      const costs: CostTracking = {
        ...defaultCosts,
        phaseCosts: { ...defaultCosts.phaseCosts, build: 1.5 },
      };
      const result = checkPhaseCostLimit('build', costs, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });

    it('returns exceeded=false when phase cost equals limit', () => {
      const costs: CostTracking = {
        ...defaultCosts,
        phaseCosts: { ...defaultCosts.phaseCosts, build: 2.0 },
      };
      const result = checkPhaseCostLimit('build', costs, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });

    it('returns exceeded=false for phase with no recorded cost', () => {
      const result = checkPhaseCostLimit('enumerate', defaultCosts, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });
  });

  describe('checkLoopCostLimit', () => {
    it('returns exceeded=false when loop cost is below limit', () => {
      const costs: CostTracking = {
        ...defaultCosts,
        loopCosts: { 'loop-1': 0.5 },
      };
      const result = checkLoopCostLimit('loop-1', costs, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });

    it('returns exceeded=false when loop cost equals limit', () => {
      const costs: CostTracking = {
        ...defaultCosts,
        loopCosts: { 'loop-1': 1.0 },
      };
      const result = checkLoopCostLimit('loop-1', costs, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });

    it('returns exceeded=false for unknown loop', () => {
      const result = checkLoopCostLimit('unknown-loop', defaultCosts, defaultLimits);
      assert.strictEqual(result.exceeded, false);
    });
  });

  describe('checkAllCostLimits', () => {
    it('returns exceeded=false when all costs are within limits', () => {
      const costs: CostTracking = {
        totalCostUsd: 2.0,
        phaseCosts: { ...defaultCosts.phaseCosts, build: 1.0 },
        loopCosts: { 'loop-1': 0.5 },
      };
      const result = checkAllCostLimits(costs, defaultLimits, 'build', ['loop-1']);
      assert.strictEqual(result.exceeded, false);
    });

    it('returns run limit exceeded first (highest priority)', () => {
      const costs: CostTracking = {
        totalCostUsd: 6.0,
        phaseCosts: { ...defaultCosts.phaseCosts, build: 3.0 },
        loopCosts: { 'loop-1': 2.0 },
      };
      const result = checkAllCostLimits(costs, defaultLimits, 'build', ['loop-1']);
      assert.strictEqual(result.exceeded, true);
      if (result.exceeded) {
        assert.strictEqual(result.type, 'run');
      }
    });

    it('returns phase limit exceeded if run limit not exceeded', () => {
      const costs: CostTracking = {
        totalCostUsd: 3.0,
        phaseCosts: { ...defaultCosts.phaseCosts, build: 2.5 },
        loopCosts: { 'loop-1': 0.5 },
      };
      const result = checkAllCostLimits(costs, defaultLimits, 'build', ['loop-1']);
      assert.strictEqual(result.exceeded, true);
      if (result.exceeded) {
        assert.strictEqual(result.type, 'phase');
      }
    });

    it('returns loop limit exceeded if run and phase limits not exceeded', () => {
      const costs: CostTracking = {
        totalCostUsd: 2.0,
        phaseCosts: { ...defaultCosts.phaseCosts, build: 1.0 },
        loopCosts: { 'loop-1': 1.5 },
      };
      const result = checkAllCostLimits(costs, defaultLimits, 'build', ['loop-1']);
      assert.strictEqual(result.exceeded, true);
      if (result.exceeded) {
        assert.strictEqual(result.type, 'loop');
      }
    });
  });

  describe('formatCostExceededError', () => {
    it('formats run cost exceeded error', () => {
      const msg = formatCostExceededError({
        exceeded: true,
        type: 'run',
        current: 5.5,
        limit: 5.0,
      });
      assert.strictEqual(msg, 'Run cost limit exceeded: $5.50 > $5.00');
    });

    it('formats phase cost exceeded error', () => {
      const msg = formatCostExceededError({
        exceeded: true,
        type: 'phase',
        current: 2.25,
        limit: 2.0,
        phase: 'build',
      });
      assert.strictEqual(msg, "Phase 'build' cost limit exceeded: $2.25 > $2.00");
    });

    it('formats loop cost exceeded error', () => {
      const msg = formatCostExceededError({
        exceeded: true,
        type: 'loop',
        current: 1.1,
        limit: 1.0,
        loopId: 'loop-abc123',
      });
      assert.strictEqual(msg, "Loop 'loop-abc123' cost limit exceeded: $1.10 > $1.00");
    });
  });
});
