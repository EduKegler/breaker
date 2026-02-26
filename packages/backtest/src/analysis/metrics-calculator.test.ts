import { describe, it, expect } from "vitest";
import { computeMetrics } from "./metrics-calculator.js";
import type { CompletedTrade } from "../types/order.js";

function makeTrade(pnl: number, rMultiple: number, direction: "long" | "short" = "long"): CompletedTrade {
  return {
    direction,
    entryPrice: 100,
    exitPrice: pnl > 0 ? 110 : 90,
    size: 1,
    pnl,
    pnlPct: pnl,
    rMultiple,
    entryTimestamp: Date.now(),
    exitTimestamp: Date.now() + 3600000,
    entryBarIndex: 0,
    exitBarIndex: 10,
    barsHeld: 10,
    exitType: "sl",
    commission: 0.5,
    slippageCost: 0.1,
    entryComment: "test",
    exitComment: "test",
  };
}

describe("computeMetrics", () => {
  it("returns nulls for empty trades", () => {
    const metrics = computeMetrics([], -5);
    expect(metrics.totalPnl).toBe(0);
    expect(metrics.numTrades).toBe(0);
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.winRate).toBeNull();
    expect(metrics.avgR).toBeNull();
    expect(metrics.maxDrawdownPct).toBe(-5);
  });

  it("calculates correct metrics for mixed trades", () => {
    const trades = [
      makeTrade(10, 2),   // win
      makeTrade(-5, -1),  // loss
      makeTrade(15, 3),   // win
      makeTrade(-3, -0.5),// loss
    ];
    const metrics = computeMetrics(trades, -10);

    expect(metrics.totalPnl).toBe(17);
    expect(metrics.numTrades).toBe(4);
    expect(metrics.profitFactor).toBeCloseTo(25 / 8, 5); // 25/8 = 3.125
    expect(metrics.winRate).toBeCloseTo(50, 5);
    expect(metrics.avgR).toBeCloseTo((2 + (-1) + 3 + (-0.5)) / 4, 5);
    expect(metrics.maxDrawdownPct).toBe(-10);
  });

  it("handles all winners", () => {
    const trades = [makeTrade(10, 2), makeTrade(20, 4)];
    const metrics = computeMetrics(trades, 0);
    expect(metrics.profitFactor).toBe(Infinity);
    expect(metrics.winRate).toBe(100);
  });

  it("handles all losers", () => {
    const trades = [makeTrade(-10, -2), makeTrade(-20, -4)];
    const metrics = computeMetrics(trades, -50);
    expect(metrics.profitFactor).toBe(0);
    expect(metrics.winRate).toBe(0);
  });

  it("handles single trade", () => {
    const metrics = computeMetrics([makeTrade(5, 1)], -2);
    expect(metrics.numTrades).toBe(1);
    expect(metrics.winRate).toBe(100);
    expect(metrics.totalPnl).toBe(5);
  });
});
