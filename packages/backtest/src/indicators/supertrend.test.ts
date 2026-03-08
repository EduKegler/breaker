import { describe, it, expect } from "vitest";
import { supertrend } from "./supertrend.js";
import type { Candle } from "../types/candle.js";

function makeCandle(
  o: number,
  h: number,
  l: number,
  c: number,
  t = 0,
): Candle {
  return { t, o, h, l, c, v: 0, n: 0 };
}

describe("supertrend", () => {
  it("returns empty arrays for empty input", () => {
    const result = supertrend([]);
    expect(result.supertrend).toEqual([]);
    expect(result.direction).toEqual([]);
  });

  it("returns all NaN when data shorter than period", () => {
    const candles = [makeCandle(100, 110, 90, 105)];
    const result = supertrend(candles, 10, 3);
    expect(result.supertrend.every(isNaN)).toBe(true);
    expect(result.direction.every(isNaN)).toBe(true);
  });

  it("output length equals input length", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const result = supertrend(candles, 3, 2);
    expect(result.supertrend).toHaveLength(30);
    expect(result.direction).toHaveLength(30);
  });

  it("NaN warmup matches ATR warmup", () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const period = 5;
    const result = supertrend(candles, period, 2);

    // ATR becomes stable after `period` bars → first valid at index period-1
    // Indices 0..period-2 are NaN
    for (let i = 0; i < period - 1; i++) {
      expect(result.supertrend[i]).toBeNaN();
      expect(result.direction[i]).toBeNaN();
    }
    // From index period-1 onward, values should be finite
    for (let i = period - 1; i < candles.length; i++) {
      expect(Number.isFinite(result.supertrend[i])).toBe(true);
      expect([1, -1]).toContain(result.direction[i]);
    }
  });

  it("direction is always 1 or -1 after warmup", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const period = 3;
    const result = supertrend(candles, period, 2);

    for (let i = period - 1; i < candles.length; i++) {
      expect([1, -1]).toContain(result.direction[i]);
    }
  });

  it("uses default period=10 and multiplier=3", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i, 105 + i, 95 + i, 102 + i),
    );
    const resultDefault = supertrend(candles);
    const resultExplicit = supertrend(candles, 10, 3);
    expect(resultDefault.supertrend).toEqual(resultExplicit.supertrend);
    expect(resultDefault.direction).toEqual(resultExplicit.direction);
  });

  it("supertrend is below price during uptrend (direction=1)", () => {
    // Steadily rising prices should produce uptrend
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(100 + i * 2, 108 + i * 2, 95 + i * 2, 105 + i * 2),
    );
    const result = supertrend(candles, 3, 1);

    for (let i = 3; i < candles.length; i++) {
      if (result.direction[i] === 1) {
        expect(result.supertrend[i]).toBeLessThan(candles[i].c);
      }
    }
  });

  it("supertrend is above price during downtrend (direction=-1)", () => {
    // Steadily falling prices should produce downtrend
    const candles = Array.from({ length: 30 }, (_, i) =>
      makeCandle(200 - i * 2, 208 - i * 2, 195 - i * 2, 197 - i * 2),
    );
    const result = supertrend(candles, 3, 1);

    for (let i = 3; i < candles.length; i++) {
      if (result.direction[i] === -1) {
        expect(result.supertrend[i]).toBeGreaterThan(candles[i].c);
      }
    }
  });

  it("detects direction change from downtrend to uptrend", () => {
    // Build a sequence: declining then sharply rising
    const candles: Candle[] = [];
    // Declining phase
    for (let i = 0; i < 10; i++) {
      candles.push(makeCandle(200 - i * 5, 205 - i * 5, 195 - i * 5, 197 - i * 5));
    }
    // Sharp rise
    for (let i = 0; i < 15; i++) {
      const base = 160 + i * 8;
      candles.push(makeCandle(base, base + 10, base - 3, base + 8));
    }

    const result = supertrend(candles, 3, 1.5);
    const dirs = result.direction.filter((d) => !isNaN(d));

    // Should contain both -1 and 1
    expect(dirs).toContain(-1);
    expect(dirs).toContain(1);

    // There should be at least one transition from -1 to 1
    let foundFlip = false;
    for (let i = 4; i < candles.length; i++) {
      if (result.direction[i - 1] === -1 && result.direction[i] === 1) {
        foundFlip = true;
        break;
      }
    }
    expect(foundFlip).toBe(true);
  });

  it("final upper band tightens (non-increasing in downtrend)", () => {
    // In a downtrend continuation, the final upper band should not increase
    // (it uses min of basic upper and prev final upper when close <= prev final upper)
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle(200 - i * 3, 205 - i * 3, 195 - i * 3, 198 - i * 3),
    );
    const result = supertrend(candles, 3, 2);

    // In downtrend segments, supertrend (= final upper band) should be non-increasing
    for (let i = 4; i < candles.length; i++) {
      if (result.direction[i] === -1 && result.direction[i - 1] === -1) {
        expect(result.supertrend[i]).toBeLessThanOrEqual(result.supertrend[i - 1] + 1e-10);
      }
    }
  });
});
