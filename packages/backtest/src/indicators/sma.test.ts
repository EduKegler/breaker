import { describe, it, expect } from "vitest";
import { sma } from "./sma.js";

describe("sma", () => {
  it("returns empty array for empty input", () => {
    expect(sma([], 3)).toEqual([]);
  });

  it("returns all NaN when period exceeds data length", () => {
    const result = sma([1, 2], 5);
    expect(result).toHaveLength(2);
    expect(result.every(isNaN)).toBe(true);
  });

  it("throws on period < 1", () => {
    expect(() => sma([1], 0)).toThrow();
  });

  it("computes correct rolling averages", () => {
    // SMA(3) on [1, 2, 3, 4, 5]
    // index 2: (1+2+3)/3 = 2
    // index 3: (2+3+4)/3 = 3
    // index 4: (3+4+5)/3 = 4
    const result = sma([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result[2]).toBeCloseTo(2, 10);
    expect(result[3]).toBeCloseTo(3, 10);
    expect(result[4]).toBeCloseTo(4, 10);
  });

  it("with period 1, returns the values themselves", () => {
    const result = sma([10, 20, 30], 1);
    expect(result).toEqual([10, 20, 30]);
  });

  it("output length equals input length", () => {
    const values = Array.from({ length: 50 }, (_, i) => i * 2);
    const result = sma(values, 10);
    expect(result).toHaveLength(50);
  });
});
