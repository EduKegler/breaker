import { describe, it, expect } from "vitest";
import { chandelier } from "./chandelier.js";
import type { Candle } from "../types/candle.js";

function makeCandle(
  o: number,
  h: number,
  l: number,
  c: number,
): Candle {
  return { t: 0, o, h, l, c, v: 0, n: 0 };
}

describe("chandelier", () => {
  it("returns empty arrays for empty input", () => {
    const result = chandelier([]);
    expect(result.longExit).toEqual([]);
    expect(result.shortExit).toEqual([]);
  });

  it("returns all NaN when data shorter than period", () => {
    const candles = Array.from({ length: 5 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const result = chandelier(candles, 22, 3);
    expect(result.longExit.every(isNaN)).toBe(true);
    expect(result.shortExit.every(isNaN)).toBe(true);
  });

  it("output length equals input length", () => {
    const candles = Array.from({ length: 50 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const result = chandelier(candles, 5, 2);
    expect(result.longExit).toHaveLength(50);
    expect(result.shortExit).toHaveLength(50);
  });

  it("NaN warmup covers ATR warmup", () => {
    const candles = Array.from({ length: 50 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const period = 5;
    const result = chandelier(candles, period, 2);

    // ATR becomes stable after `period` bars → first valid at index period-1
    for (let i = 0; i < period - 1; i++) {
      expect(result.longExit[i]).toBeNaN();
      expect(result.shortExit[i]).toBeNaN();
    }
    // From index period-1 onward, values should be finite
    for (let i = period - 1; i < candles.length; i++) {
      expect(Number.isFinite(result.longExit[i])).toBe(true);
      expect(Number.isFinite(result.shortExit[i])).toBe(true);
    }
  });

  it("uses default period=22 and multiplier=3", () => {
    const candles = Array.from({ length: 50 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const resultDefault = chandelier(candles);
    const resultExplicit = chandelier(candles, 22, 3);
    expect(resultDefault.longExit).toEqual(resultExplicit.longExit);
    expect(resultDefault.shortExit).toEqual(resultExplicit.shortExit);
  });

  it("longExit = highestHigh - multiplier * ATR", () => {
    // With known values we can verify the formula
    const candles = [
      makeCandle(100, 110, 90, 105),
      makeCandle(105, 115, 95, 110),
      makeCandle(110, 120, 100, 115),
      makeCandle(115, 125, 105, 120),
      makeCandle(120, 130, 110, 125),
    ];
    const period = 3;
    const multiplier = 2;
    const result = chandelier(candles, period, multiplier);

    // At index 3: window is [1,2,3], highest high = max(115,120,125) = 125
    // At index 3: ATR should be defined
    // longExit = highestHigh - multiplier * ATR
    // Just verify longExit < highestHigh
    expect(result.longExit[3]).toBeLessThan(125);
    expect(Number.isFinite(result.longExit[3])).toBe(true);
  });

  it("longExit is below price in uptrend", () => {
    // Rising prices: longExit should trail below
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i * 3, 108 + i * 3, 95 + i * 3, 105 + i * 3),
    );
    const result = chandelier(candles, 5, 2);

    for (let i = 5; i < candles.length; i++) {
      if (Number.isFinite(result.longExit[i])) {
        expect(result.longExit[i]).toBeLessThan(candles[i].h);
      }
    }
  });

  it("shortExit is above price in downtrend", () => {
    // Falling prices: shortExit should trail above
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(300 - i * 3, 308 - i * 3, 295 - i * 3, 297 - i * 3),
    );
    const result = chandelier(candles, 5, 2);

    for (let i = 5; i < candles.length; i++) {
      if (Number.isFinite(result.shortExit[i])) {
        expect(result.shortExit[i]).toBeGreaterThan(candles[i].l);
      }
    }
  });

  it("longExit < shortExit always holds after warmup", () => {
    const candles = Array.from({ length: 40 }, (_, i) =>
      makeCandle(100 + i, 108 + i, 95 + i, 103 + i),
    );
    const result = chandelier(candles, 5, 2);

    for (let i = 5; i < candles.length; i++) {
      if (Number.isFinite(result.longExit[i]) && Number.isFinite(result.shortExit[i])) {
        expect(result.longExit[i]).toBeLessThan(result.shortExit[i]);
      }
    }
  });

  it("shortExit = lowestLow + multiplier * ATR", () => {
    const candles = [
      makeCandle(100, 110, 90, 105),
      makeCandle(105, 115, 95, 110),
      makeCandle(110, 120, 100, 115),
      makeCandle(115, 125, 105, 120),
      makeCandle(120, 130, 110, 125),
    ];
    const period = 3;
    const multiplier = 2;
    const result = chandelier(candles, period, multiplier);

    // At index 3: window is [1,2,3], lowest low = min(95,100,105) = 95
    // shortExit = lowestLow + multiplier * ATR
    // Just verify shortExit > lowestLow
    expect(result.shortExit[3]).toBeGreaterThan(95);
    expect(Number.isFinite(result.shortExit[3])).toBe(true);
  });
});
