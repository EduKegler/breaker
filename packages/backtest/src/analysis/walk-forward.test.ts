import { describe, it, expect } from "vitest";
import { computeWalkForward } from "./walk-forward.js";
import type { CompletedTrade } from "../types/order.js";

function makeTrade(pnl: number, entryTimestamp: number, hour = 10): CompletedTrade {
  const ts = new Date(entryTimestamp);
  ts.setUTCHours(hour);
  return {
    direction: "long",
    entryPrice: 100,
    exitPrice: pnl > 0 ? 110 : 90,
    size: 1,
    pnl,
    pnlPct: pnl,
    rMultiple: pnl > 0 ? 2 : -1,
    entryTimestamp: ts.getTime(),
    exitTimestamp: ts.getTime() + 3600000,
    entryBarIndex: 0,
    exitBarIndex: 10,
    barsHeld: 10,
    exitType: pnl > 0 ? "tp1" : "sl",
    commission: 0.5,
    slippageCost: 0.1,
    entryComment: "test",
    exitComment: "test",
  };
}

describe("computeWalkForward", () => {
  it("returns null for < 10 trades", () => {
    const trades = Array.from({ length: 9 }, (_, i) =>
      makeTrade(5, Date.now() + i * 86400000),
    );
    expect(computeWalkForward(trades)).toBeNull();
  });

  it("splits 70/30 chronologically", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 20 }, (_, i) =>
      makeTrade(5, baseTime + i * 86400000),
    );
    const result = computeWalkForward(trades)!;
    expect(result.trainTrades).toBe(14); // floor(20 * 0.7)
    expect(result.testTrades).toBe(6);
    expect(result.splitRatio).toBe(0.7);
  });

  it("computes profit factors for each set", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = [
      // Train set (7 trades)
      ...Array.from({ length: 5 }, (_, i) => makeTrade(10, baseTime + i * 86400000)),
      ...Array.from({ length: 2 }, (_, i) => makeTrade(-5, baseTime + (i + 5) * 86400000)),
      // Test set (3 trades)
      ...Array.from({ length: 2 }, (_, i) => makeTrade(8, baseTime + (i + 7) * 86400000)),
      makeTrade(-4, baseTime + 9 * 86400000),
    ];
    const result = computeWalkForward(trades)!;
    expect(result.trainPF).toBeGreaterThan(0);
    expect(result.testPF).toBeGreaterThan(0);
    expect(result.pfRatio).toBeGreaterThan(0);
  });

  it("flags overfit when test PF < 50% of train PF", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = [
      // Strong train
      ...Array.from({ length: 7 }, (_, i) => makeTrade(20, baseTime + i * 86400000)),
      // Weak test
      ...Array.from({ length: 3 }, (_, i) => makeTrade(-10, baseTime + (i + 7) * 86400000)),
    ];
    const result = computeWalkForward(trades)!;
    expect(result.overfitFlag).toBe(true);
  });

  it("does not flag overfit when test performs well", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 20 }, (_, i) =>
      makeTrade(5, baseTime + i * 86400000),
    );
    const result = computeWalkForward(trades)!;
    expect(result.overfitFlag).toBe(false);
  });

  it("computes hour consistency", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 20 }, (_, i) =>
      makeTrade(i < 15 ? 5 : -3, baseTime + i * 86400000, 10),
    );
    const result = computeWalkForward(trades)!;
    expect(result.hourConsistency.length).toBeGreaterThan(0);
    expect(result.hourConsistency[0].hour).toBeDefined();
  });
});
