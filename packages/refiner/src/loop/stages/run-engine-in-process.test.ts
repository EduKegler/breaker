import { describe, it, expect } from "vitest";

import { runEngineInProcess } from "./run-engine-in-process.js";
import type { Strategy, StrategyContext, Candle } from "@breaker/backtest";

/** Minimal stub strategy for testing the engine runner — no deployed dependency. */
function createStubStrategy(paramOverrides?: Partial<Record<string, number>>): Strategy {
  const period = paramOverrides?.period ?? 20;
  return {
    name: "Stub Strategy",
    params: {
      period: { value: period, min: 5, max: 50, step: 5, optimizable: true },
    },
    requiredWarmup: { source: 50 },
    onCandle(_ctx: StrategyContext) { return null; },
  };
}

function generateCandles(count: number, startPrice = 100, interval = 900000): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const baseTime = Date.UTC(2025, 5, 1); // June 1, 2025

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.1) + Math.random() - 0.5) * 2;
    price = Math.max(50, price + change);
    const h = price + Math.random() * 2;
    const l = price - Math.random() * 2;

    candles.push({
      t: baseTime + i * interval,
      o: price,
      h,
      l: Math.max(0.01, l),
      c: price + (Math.random() - 0.5),
      v: 100 + Math.random() * 50,
      n: 10 + Math.floor(Math.random() * 5),
    });
  }
  return candles;
}

describe("runEngineInProcess", () => {
  it("returns metrics, analysis, and trades", () => {
    const candles = generateCandles(2000);
    const strategy = createStubStrategy();

    const result = runEngineInProcess({ candles, strategy });

    expect(result.metrics).toBeDefined();
    expect(result.metrics).toHaveProperty("totalPnl");
    expect(result.metrics).toHaveProperty("numTrades");
    expect(result.metrics).toHaveProperty("profitFactor");
    expect(result.metrics).toHaveProperty("maxDrawdownPct");
    expect(result.metrics).toHaveProperty("winRate");
    expect(result.metrics).toHaveProperty("avgR");

    expect(result.analysis).toBeDefined();
    expect(result.analysis).toHaveProperty("byDirection");
    expect(result.analysis).toHaveProperty("byExitType");

    expect(Array.isArray(result.trades)).toBe(true);
  });

  it("accepts custom backtest config", () => {
    const candles = generateCandles(2000);
    const strategy = createStubStrategy();

    const result = runEngineInProcess({
      candles,
      strategy,
      config: { riskPerTradeUsd: 20, initialCapital: 2000 },
    });

    expect(result.metrics).toBeDefined();
  });

  it("handles strategies with different param overrides", () => {
    const candles = generateCandles(2000);
    const strategyDefault = createStubStrategy();
    const strategyCustom = createStubStrategy({ period: 30 });

    const resultDefault = runEngineInProcess({ candles, strategy: strategyDefault });
    const resultCustom = runEngineInProcess({ candles, strategy: strategyCustom });

    expect(resultDefault.metrics).toBeDefined();
    expect(resultCustom.metrics).toBeDefined();
  });
});
