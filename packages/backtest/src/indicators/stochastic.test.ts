import { describe, it, expect } from "vitest";
import { stochastic } from "./stochastic.js";
import type { Candle } from "../types/candle.js";

function makeCandle(o: number, h: number, l: number, c: number, i = 0): Candle {
  return { t: i * 60_000, o, h, l, c, v: 100, n: 0 };
}

describe("stochastic", () => {
  it("returns empty arrays for empty input", () => {
    const result = stochastic([]);
    expect(result.k).toEqual([]);
    expect(result.d).toEqual([]);
  });

  it("output length equals input length", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i, i),
    );
    const result = stochastic(candles);
    expect(result.k).toHaveLength(30);
    expect(result.d).toHaveLength(30);
  });

  it("returns all NaN when input shorter than kPeriod", () => {
    const candles = Array.from({ length: 5 }, (_, i) =>
      makeCandle(100, 110, 90, 105, i),
    );
    const result = stochastic(candles, 14, 3);
    expect(result.k.every(isNaN)).toBe(true);
    expect(result.d.every(isNaN)).toBe(true);
  });

  it("first kPeriod-1 %K values are NaN (warmup)", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i, i),
    );
    const result = stochastic(candles, 14, 3);
    for (let i = 0; i < 13; i++) {
      expect(result.k[i]).toBeNaN();
    }
    expect(result.k[13]).not.toBeNaN();
  });

  it("first kPeriod-1 + dPeriod-1 %D values are NaN", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i, i),
    );
    const result = stochastic(candles, 14, 3);
    // %D warmup = kPeriod-1 + dPeriod-1 = 13 + 2 = 15
    for (let i = 0; i < 15; i++) {
      expect(result.d[i]).toBeNaN();
    }
    expect(result.d[15]).not.toBeNaN();
  });

  it("%K is bounded between 0 and 100", () => {
    const candles = Array.from({ length: 40 }, (_, i) =>
      makeCandle(100 + Math.sin(i) * 10, 110 + Math.sin(i) * 10, 90 + Math.sin(i) * 10, 105 + Math.sin(i) * 10, i),
    );
    const result = stochastic(candles, 14, 3);
    for (const v of result.k) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("%D is bounded between 0 and 100", () => {
    const candles = Array.from({ length: 40 }, (_, i) =>
      makeCandle(100 + Math.sin(i) * 10, 110 + Math.sin(i) * 10, 90 + Math.sin(i) * 10, 105 + Math.sin(i) * 10, i),
    );
    const result = stochastic(candles, 14, 3);
    for (const v of result.d) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("known value: close at highest high gives %K = 100", () => {
    // Build candles where period=5, close equals the highest high
    const candles: Candle[] = [
      makeCandle(10, 15, 5, 10, 0),
      makeCandle(10, 20, 5, 10, 1),
      makeCandle(10, 18, 5, 10, 2),
      makeCandle(10, 12, 5, 10, 3),
      makeCandle(10, 20, 5, 20, 4), // close=20, highest high=20, lowest low=5 → K=(20-5)/(20-5)*100=100
    ];
    const result = stochastic(candles, 5, 3);
    expect(result.k[4]).toBeCloseTo(100, 10);
  });

  it("known value: close at lowest low gives %K = 0", () => {
    const candles: Candle[] = [
      makeCandle(10, 20, 5, 10, 0),
      makeCandle(10, 20, 8, 10, 1),
      makeCandle(10, 18, 6, 10, 2),
      makeCandle(10, 15, 7, 10, 3),
      makeCandle(10, 15, 5, 5, 4), // close=5, highest high=20, lowest low=5 → K=(5-5)/(20-5)*100=0
    ];
    const result = stochastic(candles, 5, 3);
    expect(result.k[4]).toBeCloseTo(0, 10);
  });

  it("known value: midpoint close gives %K = 50", () => {
    const candles: Candle[] = [
      makeCandle(10, 20, 0, 10, 0),
      makeCandle(10, 20, 0, 10, 1),
      makeCandle(10, 20, 0, 10, 2),
      makeCandle(10, 20, 0, 10, 3),
      makeCandle(10, 20, 0, 10, 4), // close=10, HH=20, LL=0 → K=(10-0)/(20-0)*100=50
    ];
    const result = stochastic(candles, 5, 3);
    expect(result.k[4]).toBeCloseTo(50, 10);
  });

  it("flat candles (HH == LL) produce %K = 0 (no division by zero)", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(50, 50, 50, 50, i),
    );
    const result = stochastic(candles, 14, 3);
    for (const v of result.k) {
      if (!isNaN(v)) {
        expect(v).toBe(0);
      }
    }
  });

  it("uses custom periods correctly", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i, i),
    );
    const result = stochastic(candles, 5, 2);
    // %K warmup = 4
    for (let i = 0; i < 4; i++) {
      expect(result.k[i]).toBeNaN();
    }
    expect(result.k[4]).not.toBeNaN();
    // %D warmup = 4 + 1 = 5
    for (let i = 0; i < 5; i++) {
      expect(result.d[i]).toBeNaN();
    }
    expect(result.d[5]).not.toBeNaN();
  });
});
