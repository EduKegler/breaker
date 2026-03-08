import { describe, it, expect } from "vitest";
import { williamsR } from "./williams-r.js";
import type { Candle } from "../types/candle.js";

function makeCandle(
  h: number,
  l: number,
  c: number,
  v = 100,
): Candle {
  return { t: 0, o: (h + l) / 2, h, l, c, v, n: 0 };
}

describe("williamsR", () => {
  it("returns empty array for empty input", () => {
    expect(williamsR([])).toEqual([]);
  });

  it("returns single NaN for single candle with default period 14", () => {
    const result = williamsR([makeCandle(10, 5, 7)]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeNaN();
  });

  it("output length equals input length", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i, 90 + i, 95 + i),
    );
    const result = williamsR(candles, 5);
    expect(result).toHaveLength(20);
  });

  it("first period-1 values are NaN", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i, 90 + i, 95 + i),
    );
    const result = williamsR(candles, 5);
    for (let i = 0; i < 4; i++) {
      expect(result[i]).toBeNaN();
    }
    expect(result[4]).not.toBeNaN();
  });

  it("uses default period of 14", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i, 90 + i, 95 + i),
    );
    const result = williamsR(candles);
    // First 13 values should be NaN (period-1 = 13)
    for (let i = 0; i < 13; i++) {
      expect(result[i]).toBeNaN();
    }
    expect(result[13]).not.toBeNaN();
  });

  it("computes correct known values", () => {
    // Manual calculation with period=3:
    // candles: h=[10, 12, 8, 15, 11], l=[5, 6, 4, 7, 3], c=[7, 10, 6, 14, 9]
    //
    // i=2: highest(h,0..2)=12, lowest(l,0..2)=4, c=6
    //   %R = (12-6)/(12-4)*-100 = 6/8*-100 = -75
    // i=3: highest(h,1..3)=15, lowest(l,1..3)=4, c=14
    //   %R = (15-14)/(15-4)*-100 = 1/11*-100 ≈ -9.0909
    // i=4: highest(h,2..4)=15, lowest(l,2..4)=3, c=9
    //   %R = (15-9)/(15-3)*-100 = 6/12*-100 = -50
    const candles = [
      makeCandle(10, 5, 7),
      makeCandle(12, 6, 10),
      makeCandle(8, 4, 6),
      makeCandle(15, 7, 14),
      makeCandle(11, 3, 9),
    ];
    const result = williamsR(candles, 3);

    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result[2]).toBeCloseTo(-75, 8);
    expect(result[3]).toBeCloseTo(-100 / 11, 8); // -9.0909...
    expect(result[4]).toBeCloseTo(-50, 8);
  });

  it("returns values in range [-100, 0]", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + Math.sin(i) * 10, 90 + Math.sin(i) * 10, 95 + Math.cos(i) * 8),
    );
    const result = williamsR(candles, 14);
    for (let i = 13; i < result.length; i++) {
      expect(result[i]).toBeGreaterThanOrEqual(-100);
      expect(result[i]).toBeLessThanOrEqual(0);
    }
  });

  it("returns 0 when close equals highest high", () => {
    // Close at the high of the range → %R = 0
    const candles = [
      makeCandle(10, 5, 7),
      makeCandle(12, 6, 10),
      makeCandle(15, 8, 15), // close = highest high
    ];
    const result = williamsR(candles, 3);
    expect(result[2]).toBeCloseTo(0, 8);
  });

  it("returns -100 when close equals lowest low", () => {
    // Close at the low of the range → %R = -100
    const candles = [
      makeCandle(10, 5, 7),
      makeCandle(12, 3, 10),
      makeCandle(8, 6, 3), // close = lowest low
    ];
    const result = williamsR(candles, 3);
    expect(result[2]).toBe(-100);
  });

  it("returns NaN when highest high equals lowest low (flat)", () => {
    // All candles same high and low → division by zero
    const candles = [
      makeCandle(10, 10, 10),
      makeCandle(10, 10, 10),
      makeCandle(10, 10, 10),
    ];
    const result = williamsR(candles, 3);
    // When range is 0, %R is undefined (0/0), should be NaN
    expect(result[2]).toBeNaN();
  });

  it("with period 1, uses single bar high/low/close", () => {
    const candles = [
      makeCandle(20, 10, 15), // %R = (20-15)/(20-10)*-100 = -50
      makeCandle(30, 20, 25), // %R = (30-25)/(30-20)*-100 = -50
    ];
    const result = williamsR(candles, 1);
    expect(result[0]).toBeCloseTo(-50, 8);
    expect(result[1]).toBeCloseTo(-50, 8);
  });
});
