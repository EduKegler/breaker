import { describe, it, expect } from "vitest";
import { trueRange } from "./true-range.js";
import type { Candle } from "../types/candle.js";

function candle(o: number, h: number, l: number, c: number): Candle {
  return { t: 0, o, h, l, c, v: 0, n: 0 };
}

describe("trueRange", () => {
  it("returns h-l when no previous candle", () => {
    expect(trueRange(candle(10, 15, 8, 12), null)).toBe(7);
  });

  it("detects gap up (high - prev close)", () => {
    const prev = candle(5, 8, 4, 6);
    const curr = candle(12, 15, 10, 14);
    // h-l=5, |h-prevC|=9, |l-prevC|=4 → max=9
    expect(trueRange(curr, prev)).toBe(9);
  });

  it("detects gap down (prev close - low)", () => {
    const prev = candle(10, 12, 9, 11);
    const curr = candle(3, 5, 2, 4);
    // h-l=3, |h-prevC|=6, |l-prevC|=9 → max=9
    expect(trueRange(curr, prev)).toBe(9);
  });

  it("returns h-l when range dominates", () => {
    const prev = candle(10, 12, 9, 10);
    const curr = candle(9, 20, 1, 15);
    // h-l=19, |h-prevC|=10, |l-prevC|=9 → max=19
    expect(trueRange(curr, prev)).toBe(19);
  });
});
