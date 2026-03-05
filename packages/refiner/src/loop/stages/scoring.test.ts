import { describe, it, expect } from "vitest";
import { computeScore } from "./scoring.js";
import type { Metrics } from "@breaker/backtest";

describe("computeScore", () => {
  const goodMetrics: Metrics = {
    totalPnl: 200,
    numTrades: 180,
    profitFactor: 1.5,
    maxDrawdownPct: 6,
    winRate: 25,
    avgR: 0.3,
    avgWinR: 1.5,
    avgLossR: -0.7,
    maxLossR: -1.2,
    expectancy: 0.3,
  };

  it("returns score in 0-100 range", () => {
    const score = computeScore(goodMetrics, 3, 180);
    expect(score.weighted).toBeGreaterThan(0);
    expect(score.weighted).toBeLessThanOrEqual(100);
  });

  it("returns higher score for better metrics", () => {
    const good = computeScore(goodMetrics, 3, 200);
    const bad = computeScore(
      { totalPnl: 50, numTrades: 80, profitFactor: 0.8, maxDrawdownPct: 20, winRate: 15, avgR: 0.05, avgWinR: 0.5, avgLossR: -0.4, maxLossR: -1.0, expectancy: -0.1 },
      3,
      80,
    );
    expect(good.weighted).toBeGreaterThan(bad.weighted);
  });

  it("penalizes high param count (complexity)", () => {
    const lowComplexity = computeScore(goodMetrics, 3, 180);
    const highComplexity = computeScore(goodMetrics, 18, 180);
    expect(lowComplexity.weighted).toBeGreaterThan(highComplexity.weighted);
  });

  it("rewards more trades (sample confidence)", () => {
    const manyTrades = computeScore(goodMetrics, 3, 200);
    const fewTrades = computeScore(goodMetrics, 3, 30);
    expect(manyTrades.weighted).toBeGreaterThan(fewTrades.weighted);
  });

  it("includes breakdown string", () => {
    const score = computeScore(goodMetrics, 3, 180);
    expect(score.breakdown).toContain("PF:");
    expect(score.breakdown).toContain("avgR:");
    expect(score.breakdown).toContain("DD:");
  });

  it("handles null metrics gracefully", () => {
    const nullMetrics: Metrics = {
      totalPnl: null,
      numTrades: null,
      profitFactor: null,
      maxDrawdownPct: null,
      winRate: null,
      avgR: null,
      avgWinR: null,
      avgLossR: null,
      maxLossR: null,
      expectancy: null,
    };
    const score = computeScore(nullMetrics, 0, 0);
    expect(score.weighted).toBeGreaterThanOrEqual(0);
  });

  it("clamps complexityScore to 1.0 when params <= 3", () => {
    const score = computeScore(goodMetrics, 0, 180);
    expect(score.raw.complexity).toBeLessThanOrEqual(1.0);
    expect(score.raw.complexity).toBe(1.0);
  });

  it("accepts custom weights", () => {
    const score = computeScore(goodMetrics, 3, 180, { pf: 100, avgR: 0, wr: 0, dd: 0, complexity: 0, sampleConfidence: 0 });
    expect(score.weighted).toBeGreaterThan(0);
  });

  it("clamps all raw component scores to [0, 1]", () => {
    const catastrophic: Metrics = {
      totalPnl: -500, numTrades: 177, profitFactor: 0.32,
      maxDrawdownPct: -50.6, winRate: 30, avgR: -0.26,
      avgWinR: 0.4, avgLossR: -0.56, maxLossR: -1.7, expectancy: -0.26,
    };
    const score = computeScore(catastrophic, 7, 177);
    for (const [key, val] of Object.entries(score.raw)) {
      expect(val, `raw.${key} should be >= 0`).toBeGreaterThanOrEqual(0);
      expect(val, `raw.${key} should be <= 1`).toBeLessThanOrEqual(1);
    }
  });

  it("handles negative maxDrawdownPct correctly (uses absolute value)", () => {
    const negDD: Metrics = { ...goodMetrics, maxDrawdownPct: -6 };
    const posDD: Metrics = { ...goodMetrics, maxDrawdownPct: 6 };
    const negScore = computeScore(negDD, 3, 180);
    const posScore = computeScore(posDD, 3, 180);
    expect(negScore.raw.dd).toBe(posScore.raw.dd);
  });

  it("scores catastrophic strategy lower than decent strategy", () => {
    const catastrophic: Metrics = {
      totalPnl: -505, numTrades: 177, profitFactor: 0.32,
      maxDrawdownPct: -50.6, winRate: 30.5, avgR: -0.26,
      avgWinR: 0.4, avgLossR: -0.56, maxLossR: -1.7, expectancy: -0.26,
    };
    const decent: Metrics = {
      totalPnl: 60, numTrades: 26, profitFactor: 1.91,
      maxDrawdownPct: -5.6, winRate: 61.5, avgR: 0.22,
      avgWinR: 1.0, avgLossR: -0.3, maxLossR: -1.0, expectancy: 0.22,
    };
    const catScore = computeScore(catastrophic, 7, 177);
    const decScore = computeScore(decent, 6, 26);
    expect(decScore.weighted).toBeGreaterThan(catScore.weighted);
  });

  it("clamps negative avgR to 0 score", () => {
    const negAvgR: Metrics = { ...goodMetrics, avgR: -0.5 };
    const score = computeScore(negAvgR, 3, 180);
    expect(score.raw.avgR).toBe(0);
  });
});
