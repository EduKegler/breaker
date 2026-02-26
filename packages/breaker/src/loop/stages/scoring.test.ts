import { describe, it, expect } from "vitest";
import { computeScore, compareScores, countParams } from "./scoring.js";
import type { Metrics } from "@trading/backtest";

describe("countParams", () => {
  it("returns the param count as-is", () => {
    expect(countParams(5)).toBe(5);
    expect(countParams(0)).toBe(0);
  });
});

describe("computeScore", () => {
  const goodMetrics: Metrics = {
    totalPnl: 200,
    numTrades: 180,
    profitFactor: 1.5,
    maxDrawdownPct: 6,
    winRate: 25,
    avgR: 0.3,
  };

  it("returns score in 0-100 range", () => {
    const score = computeScore(goodMetrics, 3, 180);
    expect(score.weighted).toBeGreaterThan(0);
    expect(score.weighted).toBeLessThanOrEqual(100);
  });

  it("returns higher score for better metrics", () => {
    const good = computeScore(goodMetrics, 3, 200);
    const bad = computeScore(
      { totalPnl: 50, numTrades: 80, profitFactor: 0.8, maxDrawdownPct: 20, winRate: 15, avgR: 0.05 },
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
    };
    const score = computeScore(nullMetrics, 0, 0);
    expect(score.weighted).toBeGreaterThanOrEqual(0);
  });

  it("clamps complexityScore to 1.0 when params < 5", () => {
    const score = computeScore(goodMetrics, 0, 180);
    expect(score.raw.complexity).toBeLessThanOrEqual(1.0);
    expect(score.raw.complexity).toBe(1.0);
  });

  it("accepts custom weights", () => {
    const score = computeScore(goodMetrics, 3, 180, { pf: 100, avgR: 0, wr: 0, dd: 0, complexity: 0, sampleConfidence: 0 });
    expect(score.weighted).toBeGreaterThan(0);
  });
});

describe("compareScores", () => {
  it("accepts when new > old * 1.02", () => {
    expect(compareScores(55, 50)).toBe("accept");
  });

  it("rejects when new < old * 0.85", () => {
    expect(compareScores(40, 50)).toBe("reject");
  });

  it("neutral when in between", () => {
    expect(compareScores(50, 50)).toBe("neutral");
  });

  it("accepts when old is 0 and new is positive", () => {
    expect(compareScores(10, 0)).toBe("accept");
  });

  it("neutral when both are 0", () => {
    expect(compareScores(0, 0)).toBe("neutral");
  });
});
