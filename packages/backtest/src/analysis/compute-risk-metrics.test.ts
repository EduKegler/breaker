import { describe, it, expect } from "vitest";
import { computeRiskMetrics } from "./compute-risk-metrics.js";
import type { EquityPoint } from "../engine/equity-curve.js";

function makeEquityPoints(dailyEquities: number[]): EquityPoint[] {
  const points: EquityPoint[] = [];
  const baseTime = Date.UTC(2025, 0, 1);
  for (let i = 0; i < dailyEquities.length; i++) {
    const equity = dailyEquities[i];
    const peak = Math.max(...dailyEquities.slice(0, i + 1));
    points.push({
      timestamp: baseTime + i * 86_400_000,
      barIndex: i * 96,
      equity,
      drawdown: peak > 0 ? (equity - peak) / peak : 0,
    });
  }
  return points;
}

describe("computeRiskMetrics", () => {
  it("returns null for empty equity points", () => {
    const result = computeRiskMetrics([]);
    expect(result.sharpeRatio).toBeNull();
    expect(result.sortinoRatio).toBeNull();
  });

  it("returns null for single day (no returns possible)", () => {
    const points = makeEquityPoints([1000]);
    const result = computeRiskMetrics(points);
    expect(result.sharpeRatio).toBeNull();
    expect(result.sortinoRatio).toBeNull();
  });

  it("returns null when all returns are zero (no variance)", () => {
    const points = makeEquityPoints([1000, 1000, 1000, 1000, 1000]);
    const result = computeRiskMetrics(points);
    expect(result.sharpeRatio).toBeNull();
    expect(result.sortinoRatio).toBeNull();
  });

  it("computes positive Sharpe for consistently winning equity", () => {
    const equities: number[] = [1000];
    for (let i = 1; i < 30; i++) equities.push(equities[i - 1] * 1.01);
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    expect(result.sharpeRatio!).toBeGreaterThan(0);
    expect(result.sharpeRatio!).toBeGreaterThan(10);
  });

  it("computes negative Sharpe for consistently losing equity", () => {
    const equities: number[] = [1000];
    for (let i = 1; i < 30; i++) equities.push(equities[i - 1] * 0.99);
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    expect(result.sharpeRatio!).toBeLessThan(0);
  });

  it("Sortino is higher than Sharpe when losses are rare", () => {
    const equities: number[] = [1000];
    for (let i = 1; i < 30; i++) {
      const growth = i === 15 ? 0.98 : 1.01;
      equities.push(equities[i - 1] * growth);
    }
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    expect(result.sortinoRatio).not.toBeNull();
    expect(result.sortinoRatio!).toBeGreaterThan(result.sharpeRatio!);
  });

  it("handles multiple equity points per day (uses last per day)", () => {
    const baseTime = Date.UTC(2025, 0, 1);
    const points: EquityPoint[] = [
      { timestamp: baseTime, barIndex: 0, equity: 1000, drawdown: 0 },
      { timestamp: baseTime + 4 * 3_600_000, barIndex: 16, equity: 1005, drawdown: 0 },
      { timestamp: baseTime + 8 * 3_600_000, barIndex: 32, equity: 1010, drawdown: 0 },
      { timestamp: baseTime + 86_400_000, barIndex: 96, equity: 1008, drawdown: -0.002 },
      { timestamp: baseTime + 86_400_000 + 4 * 3_600_000, barIndex: 112, equity: 995, drawdown: -0.015 },
      { timestamp: baseTime + 86_400_000 + 8 * 3_600_000, barIndex: 128, equity: 998, drawdown: -0.012 },
    ];
    const result = computeRiskMetrics(points);
    // 2 days → 1 return → need ≥ 2 returns for std → null
    expect(result.sharpeRatio).toBeNull();
  });

  it("uses 252 annualization factor", () => {
    const equities: number[] = [1000];
    // Alternate: +1.1% and -0.9% → mean ≈ 0.1%, std ≈ 1%
    for (let i = 1; i <= 60; i++) {
      const ret = i % 2 === 1 ? 1.011 : 0.991;
      equities.push(equities[i - 1] * ret);
    }
    const points = makeEquityPoints(equities);
    const result = computeRiskMetrics(points);

    expect(result.sharpeRatio).not.toBeNull();
    // mean ~0.1%/day, std ~1%/day → Sharpe ≈ 0.1/1 × √252 ≈ 1.59
    expect(result.sharpeRatio!).toBeGreaterThan(1.0);
    expect(result.sharpeRatio!).toBeLessThan(2.5);
  });
});
