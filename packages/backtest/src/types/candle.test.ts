import { describe, it, expect } from "vitest";
import { CandleSchema, intervalToMs } from "./candle.js";
import type { Candle, CandleInterval } from "./candle.js";

describe("CandleSchema", () => {
  it("validates a valid candle", () => {
    const candle: Candle = {
      t: 1700000000000,
      o: 35000,
      h: 35500,
      l: 34800,
      c: 35200,
      v: 100,
      n: 50,
    };
    expect(CandleSchema.parse(candle)).toEqual(candle);
  });

  it("rejects missing fields", () => {
    expect(() => CandleSchema.parse({ t: 1, o: 2 })).toThrow();
  });

  it("rejects non-numeric fields", () => {
    expect(() =>
      CandleSchema.parse({
        t: "bad",
        o: 1,
        h: 2,
        l: 0.5,
        c: 1.5,
        v: 10,
        n: 5,
      }),
    ).toThrow();
  });
});

describe("intervalToMs", () => {
  it("returns correct ms for 1m", () => {
    expect(intervalToMs("1m")).toBe(60_000);
  });

  it("returns correct ms for 15m", () => {
    expect(intervalToMs("15m")).toBe(900_000);
  });

  it("returns correct ms for 1h", () => {
    expect(intervalToMs("1h")).toBe(3_600_000);
  });

  it("returns correct ms for 1d", () => {
    expect(intervalToMs("1d")).toBe(86_400_000);
  });

  const intervals: CandleInterval[] = [
    "1m",
    "3m",
    "5m",
    "15m",
    "30m",
    "1h",
    "2h",
    "4h",
    "8h",
    "12h",
    "1d",
    "3d",
    "1w",
    "1M",
  ];

  it("returns a positive number for all intervals", () => {
    for (const interval of intervals) {
      expect(intervalToMs(interval)).toBeGreaterThan(0);
    }
  });
});
