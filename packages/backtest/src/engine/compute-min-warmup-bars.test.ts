import { describe, it, expect } from "vitest";
import { computeMinWarmupBars } from "./compute-min-warmup-bars.js";
import type { Strategy } from "../types/strategy.js";

function makeStrategy(requiredWarmup?: Record<string, number>): Strategy {
  return {
    name: "test",
    params: {},
    onCandle: () => null,
    requiredWarmup,
  };
}

describe("computeMinWarmupBars", () => {
  it("returns 0 when requiredWarmup is undefined", () => {
    expect(computeMinWarmupBars(makeStrategy(), "15m")).toBe(0);
  });

  it("returns 0 when requiredWarmup is empty", () => {
    expect(computeMinWarmupBars(makeStrategy({}), "15m")).toBe(0);
  });

  it("returns source requirement directly when only source is specified", () => {
    expect(computeMinWarmupBars(makeStrategy({ source: 52 }), "15m")).toBe(52);
  });

  it("converts 1h HTF to source bars (15m)", () => {
    // 15 × ceil(3600000/900000) = 15 × 4 = 60, +20% margin = 72
    expect(computeMinWarmupBars(makeStrategy({ "1h": 15 }), "15m")).toBe(72);
  });

  it("converts 4h HTF to source bars (15m)", () => {
    // 22 × ceil(14400000/900000) = 22 × 16 = 352, +20% margin = 423 (ceil)
    expect(computeMinWarmupBars(makeStrategy({ "4h": 22 }), "15m")).toBe(423);
  });

  it("converts 1d HTF to source bars (15m)", () => {
    // 51 × ceil(86400000/900000) = 51 × 96 = 4896, +20% = 5876 (ceil)
    expect(computeMinWarmupBars(makeStrategy({ "1d": 51 }), "15m")).toBe(5876);
  });

  it("takes max across all timeframes (donchian-adx)", () => {
    const warmup = { source: 52, "1h": 15, "1d": 51 };
    // source=52, 1h=72, 1d=5876 → max=5876
    expect(computeMinWarmupBars(makeStrategy(warmup), "15m")).toBe(5876);
  });

  it("takes max across all timeframes (ema-pullback)", () => {
    const warmup = { source: 22, "1h": 15, "4h": 22 };
    // source=22, 1h=72, 4h=423 → max=423
    expect(computeMinWarmupBars(makeStrategy(warmup), "15m")).toBe(423);
  });

  it("takes max across all timeframes (keltner-rsi2)", () => {
    const warmup = { source: 22, "1h": 15 };
    // source=22, 1h=72 → max=72
    expect(computeMinWarmupBars(makeStrategy(warmup), "15m")).toBe(72);
  });

  it("works with 1h source interval", () => {
    // 4h HTF on 1h source: 22 × ceil(14400000/3600000) = 22 × 4 = 88, +20% = 106 (ceil)
    expect(computeMinWarmupBars(makeStrategy({ "4h": 22 }), "1h")).toBe(106);
  });

  it("works with 5m source interval", () => {
    // 1h HTF on 5m source: 15 × ceil(3600000/300000) = 15 × 12 = 180, +20% = 216
    expect(computeMinWarmupBars(makeStrategy({ "1h": 15 }), "5m")).toBe(216);
  });

  it("source requirement is NOT inflated with margin", () => {
    // source is exact — no alignment issues
    expect(computeMinWarmupBars(makeStrategy({ source: 100 }), "15m")).toBe(100);
  });

  it("ignores HTF same as source interval (1h HTF on 1h source = no conversion)", () => {
    // 1h on 1h: ratio = 1, so 15 × 1 = 15, +20% = 18
    expect(computeMinWarmupBars(makeStrategy({ "1h": 15 }), "1h")).toBe(18);
  });
});
