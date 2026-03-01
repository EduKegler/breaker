import { describe, it, expect } from "vitest";
import { computeVpvr, type VpvrInput } from "./compute-vpvr.js";

describe("computeVpvr", () => {
  it("returns empty array for no candles", () => {
    expect(computeVpvr([])).toEqual([]);
  });

  it("returns single bucket when all candles have same price", () => {
    const candles: VpvrInput[] = [
      { open: 100, high: 100, low: 100, close: 100, volume: 50 },
    ];
    const result = computeVpvr(candles);
    expect(result).toHaveLength(1);
    expect(result[0].isPoc).toBe(true);
    expect(result[0].volume).toBe(50);
  });

  it("distributes volume across correct buckets", () => {
    const candles: VpvrInput[] = [
      { open: 100, high: 110, low: 100, close: 105, volume: 1000 },
    ];
    const result = computeVpvr(candles, 10);
    expect(result).toHaveLength(10);

    // All volume should be in the buckets spanning 100-110
    const totalVol = result.reduce((sum, b) => sum + b.volume, 0);
    expect(totalVol).toBeCloseTo(1000, 1);
  });

  it("identifies POC as the bucket with highest volume", () => {
    const candles: VpvrInput[] = [
      // Heavy volume in 100-102 range
      { open: 100, high: 102, low: 100, close: 101, volume: 500 },
      { open: 100, high: 101, low: 100, close: 101, volume: 500 },
      // Light volume in 108-110 range
      { open: 108, high: 110, low: 108, close: 109, volume: 100 },
    ];
    const result = computeVpvr(candles, 10);
    const poc = result.find((b) => b.isPoc);
    expect(poc).toBeDefined();
    // POC should be in the lower price range (100-102)
    expect(poc!.priceTo).toBeLessThanOrEqual(103);
  });

  it("handles multiple candles with proportional distribution", () => {
    const candles: VpvrInput[] = [
      { open: 100, high: 120, low: 100, close: 110, volume: 200 },
      { open: 110, high: 120, low: 110, close: 115, volume: 100 },
    ];
    const result = computeVpvr(candles, 20);
    const totalVol = result.reduce((sum, b) => sum + b.volume, 0);
    expect(totalVol).toBeCloseTo(300, 1);

    // Higher price buckets (110-120) should have more total volume
    // because both candles contribute there
    const lowerHalf = result.slice(0, 10).reduce((sum, b) => sum + b.volume, 0);
    const upperHalf = result.slice(10).reduce((sum, b) => sum + b.volume, 0);
    expect(upperHalf).toBeGreaterThan(lowerHalf);
  });

  it("skips candles with zero volume", () => {
    const candles: VpvrInput[] = [
      { open: 100, high: 110, low: 100, close: 105, volume: 0 },
      { open: 100, high: 110, low: 100, close: 105, volume: 100 },
    ];
    const result = computeVpvr(candles, 10);
    const totalVol = result.reduce((sum, b) => sum + b.volume, 0);
    expect(totalVol).toBeCloseTo(100, 1);
  });

  it("returns correct bucket count", () => {
    const candles: VpvrInput[] = [
      { open: 100, high: 110, low: 90, close: 105, volume: 100 },
    ];
    expect(computeVpvr(candles, 20)).toHaveLength(20);
    expect(computeVpvr(candles, 5)).toHaveLength(5);
  });
});
