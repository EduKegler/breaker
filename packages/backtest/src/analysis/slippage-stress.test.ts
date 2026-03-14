import { describe, it, expect } from "vitest";
import type { Candle } from "../types/candle.js";
import type { Strategy, StrategyContext, Signal } from "../types/strategy.js";
import { DEFAULT_BACKTEST_CONFIG } from "../engine/engine.js";
import { runSlippageStress, DEFAULT_SCENARIOS } from "./slippage-stress.js";
import type { SlippageScenario } from "./slippage-stress.js";

function makeCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.UTC(2024, 0, 1);
  for (let i = 0; i < count; i++) {
    const t = baseTime + i * 15 * 60_000; // 15m intervals
    // Simple pattern: zigzag between 100 and 102
    const isUp = i % 20 < 10;
    const base = isUp ? 100 + (i % 10) * 0.2 : 102 - (i % 10) * 0.2;
    candles.push({ t, o: base, h: base + 0.5, l: base - 0.5, c: base, v: 1000, n: 0 });
  }
  return candles;
}

function createMockStrategy(): Strategy {
  return {
    name: "Mock Stress Test",
    params: {},
    requiredWarmup: { "15m": 5 },
    onCandle(ctx: StrategyContext): Signal | null {
      if (ctx.index < 10) return null;
      // Simple: go long every 20 bars when in uptrend phase
      if (ctx.index % 20 === 10) {
        return {
          direction: "long",
          stopLoss: ctx.currentCandle.c - 2,
          takeProfits: [{ price: ctx.currentCandle.c + 1, pctOfPosition: 1 }],
          entryPrice: null,
          comment: "mock entry",
        };
      }
      return null;
    },
  };
}

describe("runSlippageStress", () => {
  it("returns one result per scenario using default scenarios", () => {
    const candles = makeCandles(200);
    const strategy = createMockStrategy();
    const config = { ...DEFAULT_BACKTEST_CONFIG, warmupBars: 10 };

    const results = runSlippageStress(candles, strategy, config, "15m");

    expect(results).toHaveLength(DEFAULT_SCENARIOS.length);
    for (const result of results) {
      expect(result.scenario).toBeDefined();
      expect(result.metrics).toBeDefined();
      expect(result.deltaVsBase).toBeDefined();
    }
  });

  it("higher slippage produces lower or equal PnL", () => {
    const candles = makeCandles(200);
    const strategy = createMockStrategy();
    const config = { ...DEFAULT_BACKTEST_CONFIG, warmupBars: 10 };

    const results = runSlippageStress(candles, strategy, config, "15m");

    // Sort by ascending slippage
    const sorted = [...results].sort(
      (a, b) => a.scenario.slippageBps - b.scenario.slippageBps,
    );

    // Sum of slippage costs should increase with higher slippage bps.
    // We check totalPnl monotonicity only for scenarios that produce
    // the SAME number of trades (slippage can change which SL/TP fills
    // on tight-range mock data, altering trade count & outcomes).
    const baseTradeCount = sorted[0].metrics.numTrades;
    const sameTradeCount = sorted.filter(
      r => r.metrics.numTrades === baseTradeCount,
    );

    for (let i = 1; i < sameTradeCount.length; i++) {
      const previousPnl = sameTradeCount[i - 1].metrics.totalPnl ?? 0;
      const currentPnl = sameTradeCount[i].metrics.totalPnl ?? 0;
      expect(currentPnl).toBeLessThanOrEqual(previousPnl);
    }
  });

  it("base scenario has zero delta vs base", () => {
    const candles = makeCandles(200);
    const strategy = createMockStrategy();
    // Use slippageBps=3 which matches the "base" scenario label
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      warmupBars: 10,
      execution: { ...DEFAULT_BACKTEST_CONFIG.execution, slippageBps: 3 },
    };

    const results = runSlippageStress(candles, strategy, config, "15m");
    const baseResult = results.find(r => r.scenario.label === "base");

    expect(baseResult).toBeDefined();
    expect(baseResult?.deltaVsBase.pnlDelta).toBe(0);
    expect(baseResult?.deltaVsBase.pfDelta).toBe(0);
    expect(baseResult?.deltaVsBase.edgeBpsNetDelta).toBe(0);
  });

  it("accepts custom scenarios", () => {
    const candles = makeCandles(200);
    const strategy = createMockStrategy();
    const config = { ...DEFAULT_BACKTEST_CONFIG, warmupBars: 10 };

    const customScenarios: SlippageScenario[] = [
      { label: "low", slippageBps: 2 },
      { label: "high", slippageBps: 50 },
    ];

    const results = runSlippageStress(candles, strategy, config, "15m", customScenarios);

    expect(results).toHaveLength(2);
    expect(results[0].scenario.label).toBe("low");
    expect(results[1].scenario.label).toBe("high");
  });

  it("handles empty candles returning metrics with zero trades per scenario", () => {
    const strategy = createMockStrategy();
    const config = { ...DEFAULT_BACKTEST_CONFIG, warmupBars: 10 };
    const scenarios: SlippageScenario[] = [
      { label: "a", slippageBps: 5 },
      { label: "b", slippageBps: 15 },
    ];

    const results = runSlippageStress([], strategy, config, "15m", scenarios);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.metrics.numTrades).toBe(0);
      expect(result.metrics.totalPnl).toBe(0);
    }
  });

  it("delta vs base is non-zero for non-base scenarios when trades exist", () => {
    const candles = makeCandles(200);
    const strategy = createMockStrategy();
    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      warmupBars: 10,
      execution: { ...DEFAULT_BACKTEST_CONFIG.execution, slippageBps: 3 },
    };

    const results = runSlippageStress(candles, strategy, config, "15m");

    // At least one non-base scenario should have a non-zero pnlDelta
    // (assuming there are trades with different slippage)
    const nonBaseResults = results.filter(r => r.scenario.slippageBps !== 3);
    const hasNonZeroDelta = nonBaseResults.some(r => r.deltaVsBase.pnlDelta !== 0);
    expect(hasNonZeroDelta).toBe(true);
  });
});
