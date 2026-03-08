import { describe, it, expect } from "vitest";
import { aggregateCandles } from "./aggregate-candles.js";
import type { Candle } from "../types/candle.js";

function candle(t: number, o: number, h: number, l: number, c: number, v = 100, n = 10): Candle {
  return { t, o, h, l, c, v, n };
}

describe("aggregateCandles", () => {
  it("aggregates 5m candles into 15m", () => {
    const base = 900_000; // aligned to 15m
    const candles: Candle[] = [
      candle(base, 10, 15, 8, 12, 100, 5),
      candle(base + 300_000, 12, 18, 11, 14, 200, 10),
      candle(base + 600_000, 14, 20, 9, 16, 300, 15),
    ];

    const result = aggregateCandles(candles, "5m", "15m");

    expect(result).toHaveLength(1);
    expect(result[0].t).toBe(base);
    expect(result[0].o).toBe(10);
    expect(result[0].h).toBe(20);
    expect(result[0].l).toBe(8);
    expect(result[0].c).toBe(16);
    expect(result[0].v).toBe(600);
    expect(result[0].n).toBe(30);
  });

  it("returns original when target <= source", () => {
    const candles = [candle(0, 1, 2, 0, 1)];
    expect(aggregateCandles(candles, "15m", "5m")).toBe(candles);
    expect(aggregateCandles(candles, "15m", "15m")).toBe(candles);
  });

  it("returns empty array for empty input", () => {
    expect(aggregateCandles([], "5m", "15m")).toEqual([]);
  });
});
