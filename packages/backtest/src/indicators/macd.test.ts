import { describe, it, expect } from "vitest";
import { macd } from "./macd.js";
import { ema } from "./ema.js";

describe("macd", () => {
  it("returns empty arrays for empty input", () => {
    const result = macd([]);
    expect(result.macd).toEqual([]);
    expect(result.signal).toEqual([]);
    expect(result.histogram).toEqual([]);
  });

  it("output length equals input length", () => {
    const values = Array.from({ length: 50 }, (_, i) => 100 + i);
    const result = macd(values);
    expect(result.macd).toHaveLength(50);
    expect(result.signal).toHaveLength(50);
    expect(result.histogram).toHaveLength(50);
  });

  it("returns all NaN when input shorter than slow period", () => {
    const values = [1, 2, 3, 4, 5];
    const result = macd(values);
    expect(result.macd.every(isNaN)).toBe(true);
    expect(result.signal.every(isNaN)).toBe(true);
    expect(result.histogram.every(isNaN)).toBe(true);
  });

  it("first slow-1 macd values are NaN (warmup)", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = macd(values, 12, 26, 9);
    // macd line needs slowPeriod-1 = 25 bars of warmup
    for (let i = 0; i < 25; i++) {
      expect(result.macd[i]).toBeNaN();
    }
    expect(result.macd[25]).not.toBeNaN();
  });

  it("signal warmup is slow-1 + signal-1 bars", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = macd(values, 12, 26, 9);
    // signal needs slowPeriod-1 + signalPeriod-1 = 25 + 8 = 33 bars of warmup
    for (let i = 0; i < 33; i++) {
      expect(result.signal[i]).toBeNaN();
    }
    expect(result.signal[33]).not.toBeNaN();
  });

  it("histogram = macd - signal where both are defined", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = macd(values, 12, 26, 9);
    for (let i = 0; i < values.length; i++) {
      if (!isNaN(result.macd[i]) && !isNaN(result.signal[i])) {
        expect(result.histogram[i]).toBeCloseTo(
          result.macd[i] - result.signal[i],
          10,
        );
      }
    }
  });

  it("histogram is NaN when signal is NaN", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = macd(values, 12, 26, 9);
    for (let i = 0; i < values.length; i++) {
      if (isNaN(result.signal[i])) {
        expect(result.histogram[i]).toBeNaN();
      }
    }
  });

  it("macd line equals EMA(fast) - EMA(slow)", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 5);
    const fast = 12;
    const slow = 26;
    const result = macd(values, fast, slow, 9);
    const fastEma = ema(values, fast);
    const slowEma = ema(values, slow);
    for (let i = 0; i < values.length; i++) {
      if (!isNaN(fastEma[i]) && !isNaN(slowEma[i])) {
        expect(result.macd[i]).toBeCloseTo(fastEma[i] - slowEma[i], 10);
      }
    }
  });

  it("uses custom periods correctly", () => {
    const values = Array.from({ length: 40 }, (_, i) => 50 + i);
    const result = macd(values, 5, 10, 3);
    // macd warmup = slowPeriod-1 = 9
    for (let i = 0; i < 9; i++) {
      expect(result.macd[i]).toBeNaN();
    }
    expect(result.macd[9]).not.toBeNaN();
    // signal warmup = 9 + 2 = 11
    for (let i = 0; i < 11; i++) {
      expect(result.signal[i]).toBeNaN();
    }
    expect(result.signal[11]).not.toBeNaN();
  });

  it("defaults to fast=12, slow=26, signal=9", () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + i);
    const defaultResult = macd(values);
    const explicitResult = macd(values, 12, 26, 9);
    for (let i = 0; i < values.length; i++) {
      if (isNaN(defaultResult.macd[i])) {
        expect(explicitResult.macd[i]).toBeNaN();
      } else {
        expect(defaultResult.macd[i]).toBeCloseTo(explicitResult.macd[i], 10);
      }
    }
  });
});
