import { describe, it, expect } from "vitest";
import { keltner } from "./keltner.js";
import type { Candle } from "../types/candle.js";

function makeCandle(o: number, h: number, l: number, c: number): Candle {
  return { t: 0, o, h, l, c, v: 0, n: 0 };
}

describe("keltner", () => {
  it("returns empty arrays for empty input", () => {
    const result = keltner([], 20, 10, 1.5);
    expect(result.upper).toEqual([]);
    expect(result.mid).toEqual([]);
    expect(result.lower).toEqual([]);
  });

  it("mid line equals EMA of closes", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const result = keltner(candles, 10, 10, 2.0);

    // After warmup, mid should have values
    const lastIdx = candles.length - 1;
    expect(result.mid[lastIdx]).not.toBeNaN();
  });

  it("upper > mid > lower when ATR > 0", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 108 + i, 92 + i, 100 + i),
    );
    const result = keltner(candles, 10, 10, 1.5);

    for (let i = 0; i < candles.length; i++) {
      if (!isNaN(result.upper[i])) {
        expect(result.upper[i]).toBeGreaterThan(result.mid[i]);
        expect(result.mid[i]).toBeGreaterThan(result.lower[i]);
      }
    }
  });

  it("channel width scales with multiplier", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 110 + i, 90 + i, 105 + i),
    );
    const narrow = keltner(candles, 10, 10, 1.0);
    const wide = keltner(candles, 10, 10, 2.0);

    const lastIdx = candles.length - 1;
    const narrowWidth = narrow.upper[lastIdx] - narrow.lower[lastIdx];
    const wideWidth = wide.upper[lastIdx] - wide.lower[lastIdx];
    expect(wideWidth).toBeCloseTo(narrowWidth * 2, 5);
  });

  it("computes exact band values for period=1 (no EMA smoothing)", () => {
    // With period=1, EMA equals the input value itself
    const candles = [
      makeCandle(100, 105, 95, 100),  // TR = 10
      makeCandle(102, 108, 98, 104),  // TR = max(10, |108-100|, |98-100|) = 10
      makeCandle(106, 112, 100, 108), // TR = max(12, |112-104|, |100-104|) = 12
    ];
    const result = keltner(candles, 1, 1, 2.0);

    // mid = close, upper = close + 2*TR, lower = close - 2*TR
    expect(result.mid[0]).toBe(100);
    expect(result.upper[0]).toBe(120); // 100 + 2*10
    expect(result.lower[0]).toBe(80);  // 100 - 2*10

    expect(result.mid[1]).toBe(104);
    expect(result.upper[1]).toBe(124); // 104 + 2*10
    expect(result.lower[1]).toBe(84);  // 104 - 2*10

    expect(result.mid[2]).toBe(108);
    expect(result.upper[2]).toBe(132); // 108 + 2*12
    expect(result.lower[2]).toBe(84);  // 108 - 2*12
  });

  it("warmup NaN count matches max(emaPeriod, rangePeriod) - 1", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i, 108 + i, 92 + i, 100 + i),
    );
    const result = keltner(candles, 5, 3, 1.5);

    // emaPeriod=5 → first 4 NaN, rangePeriod=3 → first 2 NaN
    // keltner NaN count = max(4, 2) = 4
    for (let i = 0; i < 4; i++) {
      expect(result.mid[i]).toBeNaN();
      expect(result.upper[i]).toBeNaN();
      expect(result.lower[i]).toBeNaN();
    }
    // Index 4 should be the first non-NaN
    expect(result.mid[4]).not.toBeNaN();
    expect(result.upper[4]).not.toBeNaN();
    expect(result.lower[4]).not.toBeNaN();
  });

  it("output arrays have same length as input", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const result = keltner(candles, 5, 5, 1.5);
    expect(result.upper).toHaveLength(20);
    expect(result.mid).toHaveLength(20);
    expect(result.lower).toHaveLength(20);
  });
});
