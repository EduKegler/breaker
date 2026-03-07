import { describe, it, expect } from "vitest";
import { slope } from "./slope.js";

describe("slope", () => {
  it("returns empty array for empty input", () => {
    expect(slope([], 3)).toEqual([]);
  });

  it("throws on lookback < 1", () => {
    expect(() => slope([1, 2, 3], 0)).toThrow();
  });

  it("first lookback values are NaN", () => {
    const result = slope([10, 20, 30, 40, 50], 3);
    for (let i = 0; i < 3; i++) {
      expect(result[i]).toBeNaN();
    }
    expect(result[3]).not.toBeNaN();
  });

  it("computes difference over lookback window", () => {
    // [10, 20, 30, 40, 50], lookback=2
    // i=2: 30-10=20, i=3: 40-20=20, i=4: 50-30=20
    const result = slope([10, 20, 30, 40, 50], 2);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result[2]).toBe(20);
    expect(result[3]).toBe(20);
    expect(result[4]).toBe(20);
  });

  it("handles negative slopes", () => {
    const result = slope([50, 40, 30, 20, 10], 1);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBe(-10);
    expect(result[4]).toBe(-10);
  });

  it("propagates NaN from source series", () => {
    const result = slope([1, NaN, 3, 4, 5], 1);
    expect(result[1]).toBeNaN(); // source is NaN
    expect(result[2]).toBeNaN(); // prev is NaN
    expect(result[3]).toBe(1);   // 4-3
    expect(result[4]).toBe(1);   // 5-4
  });

  it("output length equals input length", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    expect(slope(values, 5)).toHaveLength(100);
  });

  it("lookback=1 is simple first difference", () => {
    const result = slope([2, 5, 3, 8], 1);
    expect(result[1]).toBe(3);  // 5-2
    expect(result[2]).toBe(-2); // 3-5
    expect(result[3]).toBe(5);  // 8-3
  });

  it("lookback larger than series returns all NaN", () => {
    const result = slope([1, 2, 3], 5);
    expect(result.every(isNaN)).toBe(true);
  });
});
