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
    edgeBpsGross: null,
    edgeBpsNet: null,
    avgCostBps: null,
    tradesPerDay: null,
    totalCostPct: null,
    sharpeRatio: null,
    sortinoRatio: null,
  };

  it("returns score in 0-100 range", () => {
    const score = computeScore(goodMetrics, 3, 180);
    expect(score.weighted).toBeGreaterThan(0);
    expect(score.weighted).toBeLessThanOrEqual(100);
  });

  it("returns higher score for better metrics", () => {
    const good = computeScore(goodMetrics, 3, 200);
    const bad = computeScore(
      { totalPnl: 50, numTrades: 80, profitFactor: 0.8, maxDrawdownPct: 20, winRate: 15, avgR: 0.05, avgWinR: 0.5, avgLossR: -0.4, maxLossR: -1.0, expectancy: -0.1, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null },
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

  it("rewards more trades when sampleConfidence weight is explicit", () => {
    const manyTrades = computeScore(goodMetrics, 3, 200, { sampleConfidence: 20 });
    const fewTrades = computeScore(goodMetrics, 3, 30, { sampleConfidence: 20 });
    expect(manyTrades.weighted).toBeGreaterThan(fewTrades.weighted);
  });

  it("sampleConfidence=0: more trades do NOT increase score with equal quality", () => {
    const score50 = computeScore(goodMetrics, 3, 50);
    const score200 = computeScore(goodMetrics, 3, 200);
    expect(score50.weighted).toBe(score200.weighted);
  });

  it("default weight sum is 100", () => {
    // DEFAULT_WEIGHTS is not exported, but we can verify via the breakdown string
    // that all weights sum to 100: pf(30) + avgR(25) + wr(12) + dd(18) + complexity(15) + sampleConfidence(0) = 100
    const score = computeScore(goodMetrics, 3, 180);
    const matches = score.breakdown.matchAll(/\/(\d+)/g);
    const sum = [...matches].reduce((acc, m) => acc + Number(m[1]), 0);
    expect(sum).toBe(100);
  });

  it("quality beats quantity: better PF with fewer trades scores higher", () => {
    const highPfFewTrades: Metrics = {
      ...goodMetrics, profitFactor: 1.5, numTrades: 50,
    };
    const lowPfManyTrades: Metrics = {
      ...goodMetrics, profitFactor: 0.8, numTrades: 150,
    };
    const highPfScore = computeScore(highPfFewTrades, 3, 50);
    const lowPfScore = computeScore(lowPfManyTrades, 3, 150);
    expect(highPfScore.weighted).toBeGreaterThan(lowPfScore.weighted);
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
      edgeBpsGross: null,
      edgeBpsNet: null,
      avgCostBps: null,
      tradesPerDay: null,
      totalCostPct: null,
      sharpeRatio: null,
      sortinoRatio: null,
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
      edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null,
      sharpeRatio: null, sortinoRatio: null,
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
      edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null,
      sharpeRatio: null, sortinoRatio: null,
    };
    const decent: Metrics = {
      totalPnl: 60, numTrades: 26, profitFactor: 1.91,
      maxDrawdownPct: -5.6, winRate: 61.5, avgR: 0.22,
      avgWinR: 1.0, avgLossR: -0.3, maxLossR: -1.0, expectancy: 0.22,
      edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null,
      sharpeRatio: null, sortinoRatio: null,
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

  it("handles NaN maxDrawdownPct as worst case (100)", () => {
    const nanDD: Metrics = { ...goodMetrics, maxDrawdownPct: NaN };
    const score = computeScore(nanDD, 3, 180);
    expect(score.raw.dd).toBe(0);
    expect(score.breakdown).toContain("DD: 0.0/18");
  });

  it("applies harsh penalty when trades < 20 (Bug B: score inflation)", () => {
    // 2 winning trades produce perfect WR/DD/avgR but are statistically meaningless.
    // Before fix: scored 49.5. After fix: score * (2/20) = ~5.
    const twoTradeMetrics: Metrics = {
      totalPnl: 12, numTrades: 2, profitFactor: 0,
      maxDrawdownPct: 0, winRate: 100, avgR: 0.6,
      avgWinR: 0.6, avgLossR: 0, maxLossR: 0, expectancy: 0.6,
      edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null,
      sharpeRatio: null, sortinoRatio: null,
    };
    const score = computeScore(twoTradeMetrics, 3, 2);
    expect(score.weighted).toBeLessThan(10);
  });

  it("does not apply sample floor penalty when trades >= 20", () => {
    const score = computeScore(goodMetrics, 3, 25);
    expect(score.weighted).toBeGreaterThan(30);
  });

  it("sample floor penalty is proportional to trades/20", () => {
    const metrics: Metrics = {
      totalPnl: 50, numTrades: 10, profitFactor: 1.5,
      maxDrawdownPct: 5, winRate: 50, avgR: 0.3,
      avgWinR: 1.0, avgLossR: -0.5, maxLossR: -1.0, expectancy: 0.3,
      edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null,
      sharpeRatio: null, sortinoRatio: null,
    };
    const score10 = computeScore(metrics, 3, 10);
    const score20 = computeScore({ ...metrics, numTrades: 20 }, 3, 20);
    // 10 trades should be roughly half the score of 20 trades (from the multiplier)
    expect(score10.weighted).toBeLessThan(score20.weighted * 0.7);
  });
});
