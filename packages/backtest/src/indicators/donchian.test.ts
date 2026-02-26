import { describe, it, expect } from "vitest";
import { donchian } from "./donchian.js";
import type { Candle } from "../types/candle.js";

function makeCandle(h: number, l: number): Candle {
  return { t: 0, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 0, n: 0 };
}

describe("donchian", () => {
  it("returns empty arrays for empty input", () => {
    const result = donchian([], 5);
    expect(result.upper).toEqual([]);
    expect(result.lower).toEqual([]);
    expect(result.mid).toEqual([]);
  });

  it("throws on period < 1", () => {
    expect(() => donchian([makeCandle(10, 5)], 0)).toThrow();
  });

  it("computes correct channel values", () => {
    const candles = [
      makeCandle(10, 5),  // h=10, l=5
      makeCandle(12, 6),  // h=12, l=6
      makeCandle(8, 4),   // h=8, l=4
      makeCandle(15, 7),  // h=15, l=7
      makeCandle(11, 3),  // h=11, l=3
    ];
    const result = donchian(candles, 3);

    // First 2 are NaN
    expect(result.upper[0]).toBeNaN();
    expect(result.upper[1]).toBeNaN();

    // index 2: bars 0-2 → upper=max(10,12,8)=12, lower=min(5,6,4)=4
    expect(result.upper[2]).toBe(12);
    expect(result.lower[2]).toBe(4);
    expect(result.mid[2]).toBe(8);

    // index 3: bars 1-3 → upper=max(12,8,15)=15, lower=min(6,4,7)=4
    expect(result.upper[3]).toBe(15);
    expect(result.lower[3]).toBe(4);
    expect(result.mid[3]).toBe(9.5);

    // index 4: bars 2-4 → upper=max(8,15,11)=15, lower=min(4,7,3)=3
    expect(result.upper[4]).toBe(15);
    expect(result.lower[4]).toBe(3);
    expect(result.mid[4]).toBe(9);
  });

  it("with period 1, upper=high and lower=low", () => {
    const candles = [makeCandle(10, 5), makeCandle(20, 8)];
    const result = donchian(candles, 1);
    expect(result.upper[0]).toBe(10);
    expect(result.lower[0]).toBe(5);
    expect(result.upper[1]).toBe(20);
    expect(result.lower[1]).toBe(8);
  });
});
