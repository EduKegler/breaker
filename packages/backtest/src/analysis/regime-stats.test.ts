import { describe, it, expect } from "vitest";
import { computeRegimeStats, classifyRegime } from "./regime-stats.js";
import type { CompletedTrade } from "../types/order.js";
import type { Candle } from "../types/candle.js";

function makeCandle(close: number, high: number, low: number, t: number): Candle {
  return { t, o: close, h: high, l: low, c: close, v: 100, n: 0 };
}

function makeTrade(pnl: number, entryBarIndex: number): CompletedTrade {
  return {
    direction: "long",
    entryPrice: 100,
    exitPrice: pnl > 0 ? 110 : 90,
    size: 1,
    pnl,
    pnlPct: pnl,
    rMultiple: pnl > 0 ? 2 : -1,
    entryTimestamp: 1000 + entryBarIndex * 60000,
    exitTimestamp: 1000 + (entryBarIndex + 10) * 60000,
    entryBarIndex,
    exitBarIndex: entryBarIndex + 10,
    barsHeld: 10,
    exitType: pnl > 0 ? "tp1" : "sl",
    commission: 0.5,
    slippageCost: 0.1,
    fundingCost: 0,
    entryComment: "test",
    exitComment: "test",
  };
}

// Generate trending candles: steady uptrend with strong directional moves
function makeTrendingCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += 2 + Math.sin(i * 0.1);
    const high = price + 1;
    const low = price - 0.5;
    candles.push(makeCandle(price, high, low, i * 60000));
  }
  return candles;
}

describe("computeRegimeStats", () => {
  it("returns null for empty trades", () => {
    const candles = makeTrendingCandles(100);
    expect(computeRegimeStats([], candles)).toBeNull();
  });

  it("returns null for empty candles", () => {
    const trades = [makeTrade(5, 50)];
    expect(computeRegimeStats(trades, [])).toBeNull();
  });

  it("returns record with regime keys for valid input", () => {
    const candles = makeTrendingCandles(200);
    const trades = [makeTrade(5, 100), makeTrade(-3, 150)];
    const result = computeRegimeStats(trades, candles);
    expect(result).not.toBeNull();
    const keys = Object.keys(result!);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(["trending", "ranging", "unclear"]).toContain(key);
    }
  });

  it("computes correct stats per regime bucket", () => {
    const candles = makeTrendingCandles(200);
    const trades = [
      makeTrade(10, 100),
      makeTrade(-5, 110),
      makeTrade(8, 120),
    ];
    const result = computeRegimeStats(trades, candles)!;
    expect(result).not.toBeNull();

    const totalCount = Object.values(result).reduce((s, r) => s + r.count, 0);
    const totalPnl = Object.values(result).reduce((s, r) => s + r.pnl, 0);
    expect(totalCount).toBe(3);
    expect(totalPnl).toBeCloseTo(13);
  });

  it("winRate and profitFactor compute correctly within a bucket", () => {
    const candles = makeTrendingCandles(200);
    const trades = [
      makeTrade(10, 100),
      makeTrade(-5, 105),
    ];
    const result = computeRegimeStats(trades, candles)!;

    const values = Object.values(result);
    expect(values.length).toBe(1);
    const bucket = values[0];
    expect(bucket.count).toBe(2);
    expect(bucket.winRate).toBeCloseTo(50);
    expect(bucket.profitFactor).toBeCloseTo(2);
    expect(bucket.avgTrade).toBeCloseTo(2.5);
  });
});

describe("classifyRegime", () => {
  it("returns 'unclear' when entryBarIndex is 0 (no lookback)", () => {
    expect(classifyRegime(0, [25, 30])).toBe("unclear");
  });

  it("returns 'trending' when mean ADX > 25", () => {
    const adxValues = new Array(25).fill(30);
    expect(classifyRegime(20, adxValues)).toBe("trending");
  });

  it("returns 'ranging' when mean ADX < 20", () => {
    const adxValues = new Array(25).fill(15);
    expect(classifyRegime(20, adxValues)).toBe("ranging");
  });

  it("returns 'unclear' when mean ADX is between 20 and 25", () => {
    const adxValues = new Array(25).fill(22);
    expect(classifyRegime(20, adxValues)).toBe("unclear");
  });

  it("skips NaN values in ADX lookback", () => {
    const adxValues = [...new Array(10).fill(NaN), ...new Array(15).fill(30)];
    expect(classifyRegime(20, adxValues)).toBe("trending");
  });

  it("returns 'unclear' when all ADX values are NaN", () => {
    const adxValues = new Array(25).fill(NaN);
    expect(classifyRegime(20, adxValues)).toBe("unclear");
  });
});
