import { describe, it, expect } from "vitest";
import { adx } from "./adx.js";
import type { Candle } from "../types/candle.js";

function makeCandle(o: number, h: number, l: number, c: number): Candle {
  return { t: 0, o, h, l, c, v: 0, n: 0 };
}

describe("adx", () => {
  it("returns empty arrays for empty input", () => {
    const result = adx([], 14);
    expect(result.adx).toEqual([]);
    expect(result.diPlus).toEqual([]);
    expect(result.diMinus).toEqual([]);
  });

  it("returns all NaN when data is insufficient", () => {
    // ADX needs 2*period-1 candles minimum; 3 candles with period=3 is not enough
    const candles = Array.from({ length: 3 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const result = adx(candles, 3);
    expect(result.adx.every(isNaN)).toBe(true);
  });

  it("produces valid first ADX at index 2*period-2", () => {
    const period = 3;
    // Need at least 2*3-1=5 candles for ADX
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(100 + i * 2, 105 + i * 2, 95 + i * 2, 102 + i * 2),
    );
    const result = adx(candles, period);

    // First 2*period-3 ADX should be NaN
    for (let i = 0; i < 2 * period - 2; i++) {
      expect(result.adx[i]).toBeNaN();
    }
    // First valid ADX at 2*period-2
    expect(result.adx[2 * period - 2]).not.toBeNaN();
  });

  it("DI values available before ADX (at index period-1)", () => {
    const period = 3;
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(100 + i * 2, 105 + i * 2, 95 + i * 2, 102 + i * 2),
    );
    const result = adx(candles, period);

    // DI should be available at period-1
    for (let i = 0; i < period - 1; i++) {
      expect(result.diPlus[i]).toBeNaN();
    }
    expect(result.diPlus[period - 1]).not.toBeNaN();
  });

  it("ADX values are between 0 and 100", () => {
    // Trending market
    const candles = Array.from({ length: 50 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 103 + i),
    );
    const result = adx(candles, 14);
    for (const v of result.adx) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("DI+ > DI- in uptrend", () => {
    // Steadily rising prices
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i * 3, 105 + i * 3, 98 + i * 3, 103 + i * 3),
    );
    const result = adx(candles, 5);
    // After warmup, DI+ should dominate
    const lastIdx = candles.length - 1;
    expect(result.diPlus[lastIdx]).toBeGreaterThan(result.diMinus[lastIdx]);
  });

  it("output arrays have same length as input", () => {
    const candles = Array.from({ length: 40 }, (_, i) =>
      makeCandle(100 + i, 108 + i, 92 + i, 100 + i),
    );
    const result = adx(candles, 14);
    expect(result.adx).toHaveLength(40);
    expect(result.diPlus).toHaveLength(40);
    expect(result.diMinus).toHaveLength(40);
  });

  it("DI values are in percentage range (0-100)", () => {
    const candles = Array.from({ length: 50 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 103 + i),
    );
    const result = adx(candles, 14);
    for (const v of result.diPlus) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});
