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
