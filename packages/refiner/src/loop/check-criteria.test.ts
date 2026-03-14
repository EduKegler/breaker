import { describe, it, expect } from "vitest";
import { checkCriteria, checkStretchCriteria } from "./check-criteria.js";
import type { WalkForward, RollingWalkForward } from "@breaker/backtest";

const goodMetrics = {
  totalPnl: 100,
  numTrades: 80,
  profitFactor: 1.5,
  maxDrawdownPct: 5,
  winRate: 55,
  avgR: 0.2,
};

const baseCriteria = {
  minTrades: 50,
  minPF: 1.3,
  maxDD: 10,
  minWR: 50,
  minAvgR: 0.15,
};

function mkWalkForward(overrides: Partial<WalkForward> = {}): WalkForward {
  return {
    trainTrades: 50,
    testTrades: 20,
    splitRatio: 0.7,
    hourConsistency: [],
    trainPF: 1.5,
    testPF: 1.2,
    pfRatio: 0.8,
    overfitFlag: false,
    ...overrides,
  };
}

function mkRollingWalkForward(overrides: Partial<RollingWalkForward> = {}): RollingWalkForward {
  return {
    windows: [],
    windowsPassed: 2,
    windowsTotal: 3,
    passRate: 0.67,
    worstPfRatio: 0.65,
    overfitFlag: false,
    ...overrides,
  };
}

describe("checkCriteria", () => {
  it("returns true when all criteria met", () => {
    expect(checkCriteria(goodMetrics, baseCriteria)).toBe(true);
  });

  it("returns false when PnL <= 0", () => {
    expect(checkCriteria({ ...goodMetrics, totalPnl: -1 }, baseCriteria)).toBe(false);
  });

  it("returns false when trades below minimum", () => {
    expect(checkCriteria({ ...goodMetrics, numTrades: 10 }, baseCriteria)).toBe(false);
  });

  it("returns false when PF below minimum", () => {
    expect(checkCriteria({ ...goodMetrics, profitFactor: 1.0 }, baseCriteria)).toBe(false);
  });

  it("returns false when DD above maximum", () => {
    expect(checkCriteria({ ...goodMetrics, maxDrawdownPct: 15 }, baseCriteria)).toBe(false);
  });

  it("returns false when WR below minimum", () => {
    expect(checkCriteria({ ...goodMetrics, winRate: 30 }, baseCriteria)).toBe(false);
  });

  it("returns false when avgR below minimum", () => {
    expect(checkCriteria({ ...goodMetrics, avgR: 0.05 }, baseCriteria)).toBe(false);
  });

  it("uses defaults when criteria fields are undefined", () => {
    // Default minWR is 0 (no gate), so should pass without WR gate
    expect(checkCriteria(goodMetrics, { minTrades: 50, minPF: 1.3, maxDD: 10 })).toBe(true);
  });

  // Walk-forward overfitFlag checks (fix #1)
  it("returns false when walkForward.overfitFlag is true", () => {
    const wf = mkWalkForward({ overfitFlag: true, pfRatio: 0.4 });
    expect(checkCriteria(goodMetrics, baseCriteria, wf)).toBe(false);
  });

  it("returns true when walkForward.overfitFlag is false", () => {
    const wf = mkWalkForward({ overfitFlag: false, pfRatio: 0.8 });
    expect(checkCriteria(goodMetrics, baseCriteria, wf)).toBe(true);
  });

  it("returns true when walkForward is null (not enough trades for WF)", () => {
    expect(checkCriteria(goodMetrics, baseCriteria, null)).toBe(true);
  });

  it("returns true when walkForward is undefined (backward compat)", () => {
    expect(checkCriteria(goodMetrics, baseCriteria)).toBe(true);
  });

  it("returns false when DD is negative and abs value exceeds maxDD (B1: sign fix)", () => {
    // equity-curve.ts returns maxDrawdownPct as negative (e.g., -15 for 15% DD)
    expect(checkCriteria({ ...goodMetrics, maxDrawdownPct: -15 }, baseCriteria)).toBe(false);
  });

  it("returns true when DD is negative and abs value is within maxDD (B1: sign fix)", () => {
    expect(checkCriteria({ ...goodMetrics, maxDrawdownPct: -5 }, baseCriteria)).toBe(true);
  });

  it("handles null metric fields gracefully", () => {
    const nullMetrics = {
      totalPnl: null,
      numTrades: null,
      profitFactor: null,
      maxDrawdownPct: null,
      winRate: null,
      avgR: null,
    };
    expect(checkCriteria(nullMetrics, baseCriteria)).toBe(false);
  });

  it("returns false when rollingWalkForward.overfitFlag is true", () => {
    const rwf = mkRollingWalkForward({ overfitFlag: true });
    expect(checkCriteria(goodMetrics, baseCriteria, null, rwf)).toBe(false);
  });

  it("returns true when rollingWalkForward.overfitFlag is false", () => {
    const rwf = mkRollingWalkForward({ overfitFlag: false });
    expect(checkCriteria(goodMetrics, baseCriteria, null, rwf)).toBe(true);
  });

  it("returns true when rollingWalkForward is null", () => {
    expect(checkCriteria(goodMetrics, baseCriteria, null, null)).toBe(true);
  });
});

describe("checkStretchCriteria", () => {
  it("returns true when PF meets stretch target", () => {
    const stretchMetrics = { ...goodMetrics, profitFactor: 1.90, avgR: 0.25 };
    expect(checkStretchCriteria(stretchMetrics, baseCriteria, 1.86, 0.21)).toBe(true);
  });

  it("returns false when PF below stretch target", () => {
    expect(checkStretchCriteria(goodMetrics, baseCriteria, 1.86, 0.21)).toBe(false);
  });

  it("returns false when avgR below stretch target", () => {
    const stretchMetrics = { ...goodMetrics, profitFactor: 2.0, avgR: 0.15 };
    expect(checkStretchCriteria(stretchMetrics, baseCriteria, 1.86, 0.21)).toBe(false);
  });

  it("ignores avgR when stretchAvgR is null", () => {
    const stretchMetrics = { ...goodMetrics, profitFactor: 2.0, avgR: 0.01 };
    expect(checkStretchCriteria(stretchMetrics, baseCriteria, 1.86, null)).toBe(true);
  });

  it("returns false when walkForward has overfitFlag", () => {
    const stretchMetrics = { ...goodMetrics, profitFactor: 2.0, avgR: 0.3 };
    const wf = mkWalkForward({ overfitFlag: true });
    expect(checkStretchCriteria(stretchMetrics, baseCriteria, 1.86, 0.21, wf)).toBe(false);
  });

  it("still checks other criteria (trades, DD, WR)", () => {
    const lowTrades = { ...goodMetrics, profitFactor: 2.0, numTrades: 10, avgR: 0.3 };
    expect(checkStretchCriteria(lowTrades, baseCriteria, 1.86, 0.21)).toBe(false);
  });

  it("returns false when rollingWalkForward has overfitFlag", () => {
    const stretchMetrics = { ...goodMetrics, profitFactor: 2.0, avgR: 0.3 };
    const rwf = mkRollingWalkForward({ overfitFlag: true });
    expect(checkStretchCriteria(stretchMetrics, baseCriteria, 1.86, 0.21, null, rwf)).toBe(false);
  });
});
