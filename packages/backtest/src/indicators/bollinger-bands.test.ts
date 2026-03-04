import { describe, it, expect } from "vitest";
import { bollingerBands } from "./bollinger-bands.js";
import { sma } from "./sma.js";

describe("bollingerBands", () => {
  it("returns empty arrays for empty input", () => {
    const result = bollingerBands([], 20);
    expect(result.upper).toEqual([]);
    expect(result.mid).toEqual([]);
    expect(result.lower).toEqual([]);
  });

  it("output length equals input length", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = bollingerBands(values, 5);
    expect(result.upper).toHaveLength(values.length);
    expect(result.mid).toHaveLength(values.length);
    expect(result.lower).toHaveLength(values.length);
  });

  it("first period values are NaN", () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = bollingerBands(values, 20);
    for (let i = 0; i < 20; i++) {
      expect(result.upper[i]).toBeNaN();
      expect(result.mid[i]).toBeNaN();
      expect(result.lower[i]).toBeNaN();
    }
    // First stable value
    expect(result.upper[20]).not.toBeNaN();
    expect(result.mid[20]).not.toBeNaN();
    expect(result.lower[20]).not.toBeNaN();
  });

  it("upper > mid > lower when stddev > 0", () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = bollingerBands(values, 20, 2.0);
    for (let i = 20; i < values.length; i++) {
      expect(result.upper[i]).toBeGreaterThan(result.mid[i]);
      expect(result.mid[i]).toBeGreaterThan(result.lower[i]);
    }
  });

  it("mid approximates SMA(close, period)", () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 3);
    const result = bollingerBands(values, 20);
    const smaValues = sma(values, 20);
    for (let i = 20; i < values.length; i++) {
      // trading-signals BB uses SMA internally, should match closely
      expect(result.mid[i]).toBeCloseTo(smaValues[i], 4);
    }
  });

  it("band width scales with multiplier", () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 10);
    const narrow = bollingerBands(values, 20, 1.0);
    const wide = bollingerBands(values, 20, 3.0);
    for (let i = 20; i < values.length; i++) {
      const narrowWidth = narrow.upper[i] - narrow.lower[i];
      const wideWidth = wide.upper[i] - wide.lower[i];
      expect(wideWidth).toBeCloseTo(narrowWidth * 3, 4);
    }
  });

  it("throws on period < 1", () => {
    expect(() => bollingerBands([1, 2, 3], 0)).toThrow();
  });

  it("constant input produces upper === mid === lower (stddev = 0)", () => {
    const values = Array.from({ length: 30 }, () => 50);
    const result = bollingerBands(values, 20, 2.0);
    for (let i = 20; i < values.length; i++) {
      expect(result.upper[i]).toBeCloseTo(50, 8);
      expect(result.mid[i]).toBeCloseTo(50, 8);
      expect(result.lower[i]).toBeCloseTo(50, 8);
    }
  });
});
