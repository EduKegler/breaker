import { describe, it, expect } from "vitest";
import { ema } from "./ema.js";

describe("ema", () => {
  it("returns empty array for empty input", () => {
    expect(ema([], 3)).toEqual([]);
  });

  it("returns all NaN when period exceeds data length", () => {
    const result = ema([1, 2], 5);
    expect(result).toHaveLength(2);
    expect(result.every(isNaN)).toBe(true);
  });

  it("throws on period < 1", () => {
    expect(() => ema([1, 2, 3], 0)).toThrow();
  });

  it("with period 1, returns the values themselves", () => {
    const values = [10, 20, 30];
    const result = ema(values, 1);
    expect(result).toEqual([10, 20, 30]);
  });

  it("applies EMA formula correctly", () => {
    // EMA(3) on [2, 4, 6, 8, 10]
    // k = 2/(3+1) = 0.5
    // Library uses first-value seed (not SMA):
    // index 0: 2 (not yet stable → NaN)
    // index 1: 4*0.5 + 2*0.5 = 3 (not yet stable → NaN)
    // index 2: 6*0.5 + 3*0.5 = 4.5 (first stable)
    // index 3: 8*0.5 + 4.5*0.5 = 6.25
    // index 4: 10*0.5 + 6.25*0.5 = 8.125
    const result = ema([2, 4, 6, 8, 10], 3);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result[2]).toBeCloseTo(4.5, 10);
    expect(result[3]).toBeCloseTo(6.25, 10);
    expect(result[4]).toBeCloseTo(8.125, 10);
  });

  it("output length equals input length", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const result = ema(values, 10);
    expect(result).toHaveLength(100);
  });

  it("first period-1 values are NaN", () => {
    const result = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    for (let i = 0; i < 4; i++) {
      expect(result[i]).toBeNaN();
    }
    expect(result[4]).not.toBeNaN();
  });
});
