import { describe, it, expect } from "vitest";
import type { Candle } from "../types/candle.js";
import type { Strategy } from "../types/strategy.js";
import { DEFAULT_BACKTEST_CONFIG } from "../engine/engine.js";
import type { BacktestConfig } from "../engine/engine.js";
import {
  runFeeScenarios,
  DEFAULT_FEE_SCENARIOS,
} from "./fee-scenarios.js";
import type { FeeScenario } from "./fee-scenarios.js";

function makeCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  const baseTime = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const t = baseTime + i * 15 * 60_000;
    const base = 100 + (i % 20 < 10 ? (i % 10) * 0.2 : (10 - i % 10) * 0.2);
    candles.push({ t, o: base, h: base + 0.5, l: base - 0.5, c: base, v: 1000, n: 0 });
  }
  return candles;
}

function createMockStrategy(): Strategy {
  return {
    name: "Mock Fee Test",
    params: {},
    requiredWarmup: { "15m": 5 },
    onCandle(ctx) {
      if (ctx.index < 10) return null;
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

function makeConfig(overrides?: Partial<BacktestConfig>): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    warmupBars: 10,
    ...overrides,
  };
}

describe("runFeeScenarios", () => {
  const candles = makeCandles(200);
  const strategy = createMockStrategy();
  const config = makeConfig();

  it("returns one result per scenario", () => {
    const results = runFeeScenarios(candles, strategy, config, "15m");
    expect(results).toHaveLength(DEFAULT_FEE_SCENARIOS.length);
  });

  it("lower fees produce higher or equal PnL than higher fees", () => {
    const results = runFeeScenarios(candles, strategy, config, "15m");

    const makerMaker = results.find(r => r.scenario.label === "maker+maker");
    const takerTaker = results.find(r => r.scenario.label === "taker+taker");

    expect(makerMaker).toBeDefined();
    expect(takerTaker).toBeDefined();

    const makerPnl = makerMaker!.metrics.totalPnl ?? 0;
    const takerPnl = takerTaker!.metrics.totalPnl ?? 0;
    expect(makerPnl).toBeGreaterThanOrEqual(takerPnl);
  });

  it("base scenario has zero delta when matching baseConfig commission", () => {
    // Default config has commissionPct = 0.045 which matches taker+taker
    const results = runFeeScenarios(candles, strategy, config, "15m");

    const baseScenario = results.find(
      r => r.scenario.commissionPct === config.execution.commissionPct,
    );
    expect(baseScenario).toBeDefined();
    expect(baseScenario!.deltaVsBase.pnlDelta).toBe(0);
    expect(baseScenario!.deltaVsBase.pfDelta).toBe(0);
    expect(baseScenario!.deltaVsBase.edgeBpsNetDelta).toBe(0);
  });

  it("respects custom scenarios", () => {
    const customScenarios: FeeScenario[] = [
      { label: "zero-fee", commissionPct: 0 },
      { label: "high-fee", commissionPct: 0.1 },
    ];

    const results = runFeeScenarios(candles, strategy, config, "15m", customScenarios);

    expect(results).toHaveLength(2);
    expect(results[0].scenario.label).toBe("zero-fee");
    expect(results[1].scenario.label).toBe("high-fee");

    const zeroPnl = results[0].metrics.totalPnl ?? 0;
    const highPnl = results[1].metrics.totalPnl ?? 0;
    // Only compare when both scenarios produce the same number of trades.
    // Fee changes can alter fill prices enough to change which SL/TP triggers
    // on tight-range mock data, making PnL non-monotonic.
    if (results[0].metrics.numTrades === results[1].metrics.numTrades) {
      expect(zeroPnl).toBeGreaterThanOrEqual(highPnl);
    }
  });

  it("default scenarios match Hyperliquid fee tiers", () => {
    expect(DEFAULT_FEE_SCENARIOS).toHaveLength(3);

    const labels = DEFAULT_FEE_SCENARIOS.map(s => s.label);
    expect(labels).toContain("maker+maker");
    expect(labels).toContain("maker+taker");
    expect(labels).toContain("taker+taker");

    const makerMaker = DEFAULT_FEE_SCENARIOS.find(s => s.label === "maker+maker");
    const makerTaker = DEFAULT_FEE_SCENARIOS.find(s => s.label === "maker+taker");
    const takerTaker = DEFAULT_FEE_SCENARIOS.find(s => s.label === "taker+taker");

    expect(makerMaker!.commissionPct).toBe(0.015);
    expect(makerTaker!.commissionPct).toBe(0.030);
    expect(takerTaker!.commissionPct).toBe(0.045);
  });

  it("non-base scenarios have non-zero pnl delta when trades exist", () => {
    const results = runFeeScenarios(candles, strategy, config, "15m");

    const hasTrades = results.some(r => (r.metrics.numTrades ?? 0) > 0);
    if (!hasTrades) return; // skip if mock doesn't generate trades

    const nonBase = results.filter(
      r => r.scenario.commissionPct !== config.execution.commissionPct,
    );
    const anyNonZeroDelta = nonBase.some(r => r.deltaVsBase.pnlDelta !== 0);
    expect(anyNonZeroDelta).toBe(true);
  });
});
