import { describe, it, expect } from "vitest";
import { canTrade, buildContext, createUtcDayFormatter } from "./engine-shared.js";
import type { Candle } from "../types/candle.js";

const baseCanTrade = {
  barsSinceExit: 10,
  cooldownBars: 4,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 2,
  dailyPnl: 0,
  maxDailyLossR: 2,
  initialCapital: 1000,
  tradesToday: 0,
  maxTradesPerDay: 3,
  maxGlobalTradesDay: 5,
};

describe("canTrade", () => {
  it("returns true when all conditions met", () => {
    expect(canTrade(baseCanTrade)).toBe(true);
  });

  it("returns false when in cooldown", () => {
    expect(canTrade({ ...baseCanTrade, barsSinceExit: 2 })).toBe(false);
  });

  it("returns false when max consecutive losses reached", () => {
    expect(canTrade({ ...baseCanTrade, consecutiveLosses: 2 })).toBe(false);
  });

  it("returns false when daily loss limit exceeded", () => {
    // maxDailyLossR=2, initialCapital=1000 → limit = -(2 * 1000 * 0.01) = -20
    expect(canTrade({ ...baseCanTrade, dailyPnl: -21 })).toBe(false);
  });

  it("returns false when daily trade limit reached", () => {
    expect(canTrade({ ...baseCanTrade, tradesToday: 3 })).toBe(false);
  });

  it("uses min of maxTradesPerDay and maxGlobalTradesDay", () => {
    expect(canTrade({ ...baseCanTrade, tradesToday: 3, maxGlobalTradesDay: 3 })).toBe(false);
    expect(canTrade({ ...baseCanTrade, tradesToday: 4, maxTradesPerDay: 10 })).toBe(true);
  });
});

const makeCandle = (i: number): Candle => ({
  t: 1700000000000 + i * 60000,
  o: 100 + i,
  h: 105 + i,
  l: 95 + i,
  c: 102 + i,
  v: 1000,
  n: 50,
});

describe("buildContext", () => {
  it("builds context for flat position", () => {
    const candles = [makeCandle(0), makeCandle(1), makeCandle(2)];
    const ctx = buildContext({
      candles,
      index: 1,
      position: null,
      higherTimeframes: {},
      dailyPnl: -5,
      tradesToday: 1,
      barsSinceExit: 3,
      consecutiveLosses: 0,
    });

    expect(ctx.currentCandle).toBe(candles[1]);
    expect(ctx.positionDirection).toBeNull();
    expect(ctx.positionEntryPrice).toBeNull();
    expect(ctx.positionEntryBarIndex).toBeNull();
    expect(ctx.dailyPnl).toBe(-5);
    expect(ctx.tradesToday).toBe(1);
    expect(ctx.barsSinceExit).toBe(3);
  });

  it("builds context with open position", () => {
    const candles = [makeCandle(0)];
    const ctx = buildContext({
      candles,
      index: 0,
      position: {
        direction: "long",
        entryPrice: 100,
        size: 0.01,
        entryTimestamp: 1700000000000,
        entryBarIndex: 5,
        unrealizedPnl: 10,
        fills: [],
      },
      higherTimeframes: {},
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    });

    expect(ctx.positionDirection).toBe("long");
    expect(ctx.positionEntryPrice).toBe(100);
    expect(ctx.positionEntryBarIndex).toBe(5);
  });
});

describe("createUtcDayFormatter", () => {
  it("returns a formatter that formats UTC day/month", () => {
    const fmt = createUtcDayFormatter();
    // 2024-01-15T12:00:00Z
    const result = fmt.format(new Date(Date.UTC(2024, 0, 15, 12, 0, 0)));
    expect(result).toBe("1/15");
  });
});
