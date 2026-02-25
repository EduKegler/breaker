import { describe, it, expect } from "vitest";
import { computeScore, compareScores, countFilters } from "./scoring.js";
import type { Metrics } from "../../types/parse-results.js";

describe("countFilters", () => {
  it("counts boolean filters, hours, and days", () => {
    const pine = `
useRsi = true
useVwap = false
useSessionFilter = true
badHour = utcHour == 0 or utcHour == 1 or utcHour == 5
badDay = dayofweek == dayofweek.monday or dayofweek == dayofweek.tuesday
    `;
    // 2 true filters + 3 hours + 2 days = 7
    expect(countFilters(pine)).toBe(7);
  });

  it("counts day filters written as badDay comparisons", () => {
    const pine = `
badDay = dayofweek(time, "UTC")
dayOk = not (badDay == dayofweek.monday or badDay == dayofweek.friday)
    `;
    expect(countFilters(pine)).toBe(2);
  });

  it("ignores commented filters", () => {
    const pine = `
// useRsi = true
useVwap = true
// utcHour == 10
// badDay == dayofweek.monday
    `;
    expect(countFilters(pine)).toBe(1);
  });

  it("returns 0 for empty content", () => {
    expect(countFilters("")).toBe(0);
  });

  it("counts badHour == N patterns (not just utcHour)", () => {
    const pine = `
isBadHour = badHour == 0 or badHour == 4 or badHour == 6
    `;
    expect(countFilters(pine)).toBe(3);
  });

  it("counts mixed utcHour and badHour patterns", () => {
    const pine = `
badHour = utcHour == 0 or utcHour == 1
isBadHour2 = badHour == 10
    `;
    // 2 utcHour + 1 badHour = 3
    expect(countFilters(pine)).toBe(3);
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
    const score = computeScore(goodMetrics, "useSessionFilter = true", 180);
    expect(score.weighted).toBeGreaterThan(0);
    expect(score.weighted).toBeLessThanOrEqual(100);
  });

  it("returns higher score for better metrics", () => {
    const good = computeScore(goodMetrics, "", 200);
    const bad = computeScore(
      { totalPnl: 50, numTrades: 80, profitFactor: 0.8, maxDrawdownPct: 20, winRate: 15, avgR: 0.05 },
      "",
      80,
    );
    expect(good.weighted).toBeGreaterThan(bad.weighted);
  });

  it("penalizes high complexity", () => {
    const lowComplexity = computeScore(goodMetrics, "", 180);
    const highComplexity = computeScore(
      goodMetrics,
      "useRsi = true\nuseVwap = true\nuseSessionFilter = true\n" +
      Array.from({ length: 15 }, (_, i) => `utcHour == ${i}`).join(" or ") +
      "\n" + "dayofweek == dayofweek.monday or dayofweek == dayofweek.tuesday",
      180,
    );
    expect(lowComplexity.weighted).toBeGreaterThan(highComplexity.weighted);
  });

  it("rewards more trades (sample confidence)", () => {
    const manyTrades = computeScore(goodMetrics, "", 200);
    const fewTrades = computeScore(goodMetrics, "", 30);
    expect(manyTrades.weighted).toBeGreaterThan(fewTrades.weighted);
  });

  it("includes breakdown string", () => {
    const score = computeScore(goodMetrics, "", 180);
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
    const score = computeScore(nullMetrics, "", 0);
    expect(score.weighted).toBeGreaterThanOrEqual(0);
  });

  it("clamps complexityScore to 1.0 when filters < 5", () => {
    // filters=0 → raw formula gives 1.333, must clamp to 1.0
    const score = computeScore(goodMetrics, "", 180);
    expect(score.raw.complexity).toBeLessThanOrEqual(1.0);
    expect(score.raw.complexity).toBe(1.0);
  });

  it("accepts custom weights", () => {
    const score = computeScore(goodMetrics, "", 180, { pf: 100, avgR: 0, wr: 0, dd: 0, complexity: 0, sampleConfidence: 0 });
    // PF dominates
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
