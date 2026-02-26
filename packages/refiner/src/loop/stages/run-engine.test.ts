import { describe, it, expect } from "vitest";
import { runEngineInProcess } from "./run-engine.js";
import { createDonchianAdx } from "@breaker/backtest";
import type { Candle } from "@breaker/backtest";

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
    // Need enough candles for indicators to warm up
    const candles = generateCandles(2000);
    const strategy = createDonchianAdx();

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
    const strategy = createDonchianAdx();

    const result = runEngineInProcess({
      candles,
      strategy,
      config: { riskPerTradeUsd: 20, initialCapital: 2000 },
    });

    expect(result.metrics).toBeDefined();
  });

  it("handles strategies with different param overrides", () => {
    const candles = generateCandles(2000);
    const strategyDefault = createDonchianAdx();
    const strategyCustom = createDonchianAdx({ dcSlow: 30, dcFast: 10 });

    const resultDefault = runEngineInProcess({ candles, strategy: strategyDefault });
    const resultCustom = runEngineInProcess({ candles, strategy: strategyCustom });

    // Both should produce valid results (metrics may differ)
    expect(resultDefault.metrics).toBeDefined();
    expect(resultCustom.metrics).toBeDefined();
  });
});
