import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("execa", () => ({
  execaSync: vi.fn(),
}));

import { execaSync } from "execa";
import { runEngineInProcess, runEngineChild } from "./run-engine.js";
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

describe("runEngineChild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns child process and parses JSON result", () => {
    const fakeResult = {
      metrics: { totalPnl: 42, numTrades: 5 },
      analysis: { byDirection: {}, byExitType: {} },
      trades: [],
    };
    vi.mocked(execaSync).mockReturnValue({ stdout: JSON.stringify(fakeResult) } as any);

    const result = runEngineChild({
      repoRoot: "/repo",
      factoryName: "createDonchianAdx",
      dbPath: "/repo/.cache/candles.db",
      coin: "BTC",
      source: "binance",
      interval: "15m",
      startTime: 1000,
      endTime: 2000,
    });

    expect(result).toEqual(fakeResult);
    expect(execaSync).toHaveBeenCalledWith(
      "node",
      ["/repo/dist/loop/stages/run-engine-child.js"],
      expect.objectContaining({ cwd: "/repo", timeout: 30000 }),
    );
  });

  it("passes paramOverrides in stdin input", () => {
    const fakeResult = { metrics: {}, analysis: {}, trades: [] };
    vi.mocked(execaSync).mockReturnValue({ stdout: JSON.stringify(fakeResult) } as any);

    runEngineChild({
      repoRoot: "/repo",
      factoryName: "createDonchianAdx",
      paramOverrides: { dcSlow: 40 },
      dbPath: "/db",
      coin: "ETH",
      source: "binance",
      interval: "1h",
      startTime: 100,
      endTime: 200,
    });

    const call = vi.mocked(execaSync).mock.calls[0];
    const input = JSON.parse(call[2]!.input as string);
    expect(input.factoryName).toBe("createDonchianAdx");
    expect(input.paramOverrides).toEqual({ dcSlow: 40 });
    expect(input.coin).toBe("ETH");
  });

  it("throws when child process returns invalid JSON", () => {
    vi.mocked(execaSync).mockReturnValue({ stdout: "not json" } as any);

    expect(() =>
      runEngineChild({
        repoRoot: "/repo",
        factoryName: "createDonchianAdx",
        dbPath: "/db",
        coin: "BTC",
        source: "binance",
        interval: "15m",
        startTime: 0,
        endTime: 1,
      }),
    ).toThrow();
  });
});
