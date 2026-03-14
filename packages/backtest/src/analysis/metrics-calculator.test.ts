import { describe, it, expect } from "vitest";
import { computeMetrics } from "./metrics-calculator.js";
import type { CompletedTrade } from "../types/order.js";

function makeTrade(
  pnl: number,
  rMultiple: number,
  direction: "long" | "short" = "long",
  costs?: { commission?: number; slippageCost?: number; fundingCost?: number },
): CompletedTrade {
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
    commission: costs?.commission ?? 0.5,
    slippageCost: costs?.slippageCost ?? 0.1,
    fundingCost: costs?.fundingCost ?? 0,
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

  it("computes R-multiple diagnostics for mixed trades", () => {
    const trades = [
      makeTrade(10, 2),   // win
      makeTrade(-5, -1),  // loss
      makeTrade(15, 3),   // win
      makeTrade(-3, -0.5),// loss
    ];
    const metrics = computeMetrics(trades, -10);

    expect(metrics.avgWinR).toBeCloseTo(2.5, 5);    // (2+3)/2
    expect(metrics.avgLossR).toBeCloseTo(-0.75, 5);  // (-1+-0.5)/2
    expect(metrics.maxLossR).toBeCloseTo(-1, 5);
    // expectancy = avgWin*wr + avgLoss*(1-wr) in R-units
    // = 2.5*0.5 + (-0.75)*0.5 = 0.875
    expect(metrics.expectancy).toBeCloseTo(0.875, 5);
  });

  it("R-diagnostics are null for empty trades", () => {
    const metrics = computeMetrics([], -5);
    expect(metrics.avgWinR).toBeNull();
    expect(metrics.avgLossR).toBeNull();
    expect(metrics.maxLossR).toBeNull();
    expect(metrics.expectancy).toBeNull();
  });

  it("R-diagnostics handle all winners", () => {
    const trades = [makeTrade(10, 2), makeTrade(20, 4)];
    const metrics = computeMetrics(trades, 0);
    expect(metrics.avgWinR).toBeCloseTo(3, 5);
    expect(metrics.avgLossR).toBeNull();
    expect(metrics.maxLossR).toBeNull();
    expect(metrics.expectancy).toBeCloseTo(3, 5); // all wins → expectancy = avgWinR
  });

  it("R-diagnostics handle all losers", () => {
    const trades = [makeTrade(-10, -2), makeTrade(-20, -4)];
    const metrics = computeMetrics(trades, -50);
    expect(metrics.avgWinR).toBeNull();
    expect(metrics.avgLossR).toBeCloseTo(-3, 5);
    expect(metrics.maxLossR).toBeCloseTo(-4, 5);
    expect(metrics.expectancy).toBeCloseTo(-3, 5); // all losses → expectancy = avgLossR
  });

  // --- Cost-aware metrics ---

  it("computes cost-aware metrics for trades with known costs", () => {
    const costs = { commission: 0.5, slippageCost: 0.1, fundingCost: 0.2 };
    const trades = [
      makeTrade(10, 2, "long", costs),
      makeTrade(-5, -1, "short", costs),
      makeTrade(15, 3, "long", costs),
      makeTrade(-3, -0.5, "short", costs),
    ];
    // notional per trade = entryPrice * size = 100 * 1 = 100
    // totalCost per trade = 0.5 + 0.1 + 0.2 = 0.8
    // grossPnl per trade = pnl + totalCost = 10.8, -4.2, 15.8, -2.2
    // grossBps per trade = grossPnl / 100 * 10000
    // netBps per trade = pnl / 100 * 10000
    // costBps per trade = 0.8 / 100 * 10000 = 80
    const metrics = computeMetrics(trades, -10, 30, 1000);

    // edgeBpsGross = avg of [1080, -420, 1580, -220] = 2020/4 = 505
    expect(metrics.edgeBpsGross).toBeCloseTo(505, 1);
    // edgeBpsNet = avg of [1000, -500, 1500, -300] = 1700/4 = 425
    expect(metrics.edgeBpsNet).toBeCloseTo(425, 1);
    // avgCostBps = 80 (same for all trades)
    expect(metrics.avgCostBps).toBeCloseTo(80, 1);
    // tradesPerDay = 4 / 30
    expect(metrics.tradesPerDay).toBeCloseTo(4 / 30, 5);
    // totalCostPct = (0.8 * 4) / 1000 * 100 = 0.32%
    expect(metrics.totalCostPct).toBeCloseTo(0.32, 5);
  });

  it("cost-aware metrics are null for empty trades", () => {
    const metrics = computeMetrics([], -5, 30, 1000);
    expect(metrics.edgeBpsGross).toBeNull();
    expect(metrics.edgeBpsNet).toBeNull();
    expect(metrics.avgCostBps).toBeNull();
    expect(metrics.tradesPerDay).toBeNull();
    expect(metrics.totalCostPct).toBeNull();
  });

  it("tradesPerDay is null when tradingDays is 0", () => {
    const trades = [makeTrade(10, 2, "long", { commission: 0.5, slippageCost: 0.1, fundingCost: 0 })];
    const metrics = computeMetrics(trades, -5, 0, 1000);
    expect(metrics.tradesPerDay).toBeNull();
    // other cost-aware fields still computed
    expect(metrics.edgeBpsNet).not.toBeNull();
  });

  it("totalCostPct is null when initialCapital is 0", () => {
    const trades = [makeTrade(10, 2, "long", { commission: 0.5, slippageCost: 0.1, fundingCost: 0 })];
    const metrics = computeMetrics(trades, -5, 30, 0);
    expect(metrics.totalCostPct).toBeNull();
    expect(metrics.edgeBpsNet).not.toBeNull();
  });

  it("cost-aware defaults work without optional params (backward compat)", () => {
    const trades = [makeTrade(10, 2)];
    const metrics = computeMetrics(trades, -5);
    // tradingDays=0 → tradesPerDay null
    expect(metrics.tradesPerDay).toBeNull();
    // initialCapital=0 → totalCostPct null
    expect(metrics.totalCostPct).toBeNull();
    // edge bps still computed
    expect(metrics.edgeBpsGross).not.toBeNull();
    expect(metrics.edgeBpsNet).not.toBeNull();
    expect(metrics.avgCostBps).not.toBeNull();
  });
});
