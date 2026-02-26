import { describe, it, expect } from "vitest";
import { atr, trueRange } from "./atr.js";
import type { Candle } from "../types/candle.js";

function makeCandle(o: number, h: number, l: number, c: number): Candle {
  return { t: 0, o, h, l, c, v: 0, n: 0 };
}

describe("trueRange", () => {
  it("uses high-low when no previous candle", () => {
    const candle = makeCandle(100, 110, 90, 105);
    expect(trueRange(candle, null)).toBe(20);
  });

  it("uses max of 3 ranges with previous candle", () => {
    const prev = makeCandle(100, 110, 90, 105);
    // Current: h=115, l=100 → h-l=15, |h-prevC|=10, |l-prevC|=5
    const curr = makeCandle(106, 115, 100, 112);
    expect(trueRange(curr, prev)).toBe(15);
  });

  it("handles gap up", () => {
    const prev = makeCandle(90, 95, 85, 93);
    // Gap up: h=110, l=105. h-l=5, |h-93|=17, |l-93|=12
    const curr = makeCandle(106, 110, 105, 108);
    expect(trueRange(curr, prev)).toBe(17);
  });

  it("handles gap down", () => {
    const prev = makeCandle(100, 105, 95, 100);
    // Gap down: h=85, l=80. h-l=5, |h-100|=15, |l-100|=20
    const curr = makeCandle(83, 85, 80, 82);
    expect(trueRange(curr, prev)).toBe(20);
  });
});

describe("atr", () => {
  it("returns empty array for empty input", () => {
    expect(atr([], 14)).toEqual([]);
  });

  it("returns all NaN when data <= period", () => {
    const candles = [makeCandle(100, 110, 90, 105)];
    const result = atr(candles, 5);
    expect(result.every(isNaN)).toBe(true);
  });

  it("computes ATR with Wilder smoothing", () => {
    // 5 candles, period 3
    const candles = [
      makeCandle(100, 110, 95, 105), // TR: 15
      makeCandle(105, 115, 100, 110), // TR: max(15, |115-105|, |100-105|) = 15
      makeCandle(110, 120, 105, 115), // TR: max(15, |120-110|, |105-110|) = 15
      makeCandle(115, 125, 108, 120), // TR: max(17, |125-115|, |108-115|) = 17
      makeCandle(120, 128, 112, 125), // TR: max(16, |128-120|, |112-120|) = 16
    ];
    const result = atr(candles, 3);

    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    // ATR[2] = SMA of first 3 TRs = (15+15+15)/3 = 15
    expect(result[2]).toBeCloseTo(15, 5);
    // ATR[3] = (15 * 2 + 17) / 3 = 47/3 ≈ 15.667
    expect(result[3]).toBeCloseTo(47 / 3, 5);
    // ATR[4] = (15.667 * 2 + 16) / 3 ≈ 15.778
    expect(result[4]).toBeCloseTo((47 / 3 * 2 + 16) / 3, 5);
  });

  it("output length equals input length", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const result = atr(candles, 14);
    expect(result).toHaveLength(30);
  });
});
