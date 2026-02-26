import { describe, it, expect } from "vitest";
import { rsi } from "./rsi.js";

describe("rsi", () => {
  it("returns empty array for empty input", () => {
    expect(rsi([], 14)).toEqual([]);
  });

  it("returns all NaN when data <= period", () => {
    const result = rsi([1, 2, 3], 5);
    expect(result.every(isNaN)).toBe(true);
  });

  it("throws on period < 1", () => {
    expect(() => rsi([1], 0)).toThrow();
  });

  it("returns 100 when all changes are positive", () => {
    const values = [1, 2, 3, 4, 5, 6];
    const result = rsi(values, 3);
    // After period 3: avgGain = (1+1+1)/3 = 1, avgLoss = 0 → RSI = 100
    expect(result[3]).toBe(100);
  });

  it("returns 0 when all changes are negative", () => {
    const values = [6, 5, 4, 3, 2, 1];
    const result = rsi(values, 3);
    // avgGain = 0, avgLoss = 1 → RSI = 0
    expect(result[3]).toBe(0);
  });

  it("returns ~50 for equal gains and losses", () => {
    // Alternating +1, -1
    const values = [10, 11, 10, 11, 10, 11, 10, 11];
    const result = rsi(values, 4);
    // First RSI at index 4: gains = 2, losses = 2 → avg equal → RSI = 50
    expect(result[4]).toBeCloseTo(50, 5);
  });

  it("RSI values are between 0 and 100", () => {
    const values = Array.from({ length: 50 }, () => Math.random() * 100);
    const result = rsi(values, 14);
    for (const v of result) {
      if (!isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("output length equals input length", () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(values, 14)).toHaveLength(30);
  });
});
