import { describe, it, expect } from "vitest";
import { vwap } from "./vwap.js";
import type { Candle } from "../types/candle.js";

function makeCandle(
  h: number,
  l: number,
  c: number,
  v: number,
): Candle {
  return { t: 0, o: (h + l) / 2, h, l, c, v, n: 0 };
}

describe("vwap", () => {
  it("returns empty arrays for empty input", () => {
    const result = vwap([]);
    expect(result.vwap).toEqual([]);
    expect(result.upper).toEqual([]);
    expect(result.lower).toEqual([]);
  });

  it("output length equals input length", () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(100 + i, 90 + i, 95 + i, 1000),
    );
    const result = vwap(candles);
    expect(result.vwap).toHaveLength(10);
    expect(result.upper).toHaveLength(10);
    expect(result.lower).toHaveLength(10);
  });

  it("first value equals typical price of first candle", () => {
    const candle = makeCandle(30, 10, 20, 500);
    const tp = (30 + 10 + 20) / 3; // 20
    const result = vwap([candle]);
    expect(result.vwap[0]).toBeCloseTo(tp, 8);
  });

  it("no NaN warmup — first candle is always valid", () => {
    const candles = [
      makeCandle(30, 10, 20, 500),
      makeCandle(40, 20, 30, 1000),
    ];
    const result = vwap(candles);
    expect(result.vwap[0]).not.toBeNaN();
    expect(result.upper[0]).not.toBeNaN();
    expect(result.lower[0]).not.toBeNaN();
    expect(result.vwap[1]).not.toBeNaN();
  });

  it("computes correct cumulative VWAP", () => {
    // candle 0: tp=(30+10+20)/3=20, vol=100 → cumTPV=2000, cumV=100 → vwap=20
    // candle 1: tp=(40+20+30)/3=30, vol=200 → cumTPV=2000+6000=8000, cumV=300 → vwap=26.667
    // candle 2: tp=(50+30+40)/3=40, vol=100 → cumTPV=8000+4000=12000, cumV=400 → vwap=30
    const candles = [
      makeCandle(30, 10, 20, 100),
      makeCandle(40, 20, 30, 200),
      makeCandle(50, 30, 40, 100),
    ];
    const result = vwap(candles);
    expect(result.vwap[0]).toBeCloseTo(20, 8);
    expect(result.vwap[1]).toBeCloseTo(8000 / 300, 8);
    expect(result.vwap[2]).toBeCloseTo(30, 8);
  });

  it("upper > vwap > lower when stddev > 0", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i * 2, 90 + i, 95 + i, 1000 + i * 100),
    );
    const result = vwap(candles);
    // After a few candles, variance should build up
    for (let i = 1; i < candles.length; i++) {
      if (result.upper[i] !== result.lower[i]) {
        expect(result.upper[i]).toBeGreaterThan(result.vwap[i]);
        expect(result.lower[i]).toBeLessThan(result.vwap[i]);
      }
    }
  });

  it("band width scales with multiplier", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i * 3, 80 + i, 90 + i * 2, 1000),
    );
    const narrow = vwap(candles, 1);
    const wide = vwap(candles, 3);
    // At any index, the band distance from vwap should scale proportionally
    for (let i = 1; i < candles.length; i++) {
      const narrowDist = narrow.upper[i] - narrow.vwap[i];
      const wideDist = wide.upper[i] - wide.vwap[i];
      if (narrowDist > 0) {
        expect(wideDist).toBeCloseTo(narrowDist * 3, 6);
      }
    }
  });

  it("uses default bandMultiplier of 2", () => {
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(100 + i * 3, 80 + i, 90 + i * 2, 1000),
    );
    const defaultResult = vwap(candles);
    const explicit = vwap(candles, 2);
    for (let i = 0; i < candles.length; i++) {
      expect(defaultResult.upper[i]).toBeCloseTo(explicit.upper[i], 10);
      expect(defaultResult.lower[i]).toBeCloseTo(explicit.lower[i], 10);
    }
  });

  it("handles zero volume gracefully (carry forward)", () => {
    const candles = [
      makeCandle(30, 10, 20, 100), // tp=20, vwap=20
      makeCandle(40, 20, 30, 0),   // zero volume → carry forward vwap
      makeCandle(50, 30, 40, 200), // normal volume
    ];
    const result = vwap(candles);
    expect(result.vwap[0]).toBeCloseTo(20, 8);
    // Zero volume bar should carry forward previous VWAP
    expect(result.vwap[1]).toBeCloseTo(20, 8);
    // Third bar resumes normal computation
    expect(result.vwap[2]).not.toBeNaN();
    expect(Number.isFinite(result.vwap[2])).toBe(true);
  });

  it("handles all-zero volume", () => {
    const candles = [
      makeCandle(30, 10, 20, 0),
      makeCandle(40, 20, 30, 0),
    ];
    const result = vwap(candles);
    // First candle with zero volume: typical price as fallback
    const tp0 = (30 + 10 + 20) / 3;
    expect(result.vwap[0]).toBeCloseTo(tp0, 8);
    // Second also zero volume: carry forward
    expect(result.vwap[1]).toBeCloseTo(tp0, 8);
  });

  it("constant price produces upper === vwap === lower (no deviation)", () => {
    const candles = Array.from({ length: 10 }, () =>
      makeCandle(50, 50, 50, 100),
    );
    const result = vwap(candles);
    for (let i = 0; i < candles.length; i++) {
      expect(result.vwap[i]).toBeCloseTo(50, 8);
      expect(result.upper[i]).toBeCloseTo(50, 8);
      expect(result.lower[i]).toBeCloseTo(50, 8);
    }
  });

  it("first candle has upper === lower === vwap (zero stddev at n=1)", () => {
    const candle = makeCandle(30, 10, 20, 500);
    const result = vwap([candle]);
    expect(result.upper[0]).toBeCloseTo(result.vwap[0], 8);
    expect(result.lower[0]).toBeCloseTo(result.vwap[0], 8);
  });
});
