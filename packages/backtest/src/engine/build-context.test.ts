import { describe, it, expect } from "vitest";
import { buildContext } from "./build-context.js";
import type { Candle } from "../types/candle.js";

const makeCandle = (i: number): Candle => ({
  t: 1700000000000 + i * 900_000,
  o: 100 + i,
  h: 105 + i,
  l: 95 + i,
  c: 102 + i,
  v: 1000,
  n: 50,
});

const baseParams = {
  candles: Array.from({ length: 5 }, (_, i) => makeCandle(i)),
  index: 2,
  position: null,
  higherTimeframes: {},
  dailyPnl: 0,
  tradesToday: 0,
  barsSinceExit: 5,
};

describe("buildContext", () => {
  it("returns standard StrategyContext fields", () => {
    const ctx = buildContext(baseParams);
    expect(ctx.candles).toBe(baseParams.candles);
    expect(ctx.index).toBe(2);
    expect(ctx.currentCandle).toBe(baseParams.candles[2]);
    expect(ctx.positionDirection).toBeNull();
    expect(ctx.positionEntryPrice).toBeNull();
    expect(ctx.positionEntryBarIndex).toBeNull();
  });

  describe("diagnosticsEnabled: false (default)", () => {
    it("track() returns passed value as passthrough", () => {
      const ctx = buildContext(baseParams);
      expect(ctx.track("cond", true, 10, 5)).toBe(true);
      expect(ctx.track("cond", false, 3, 5)).toBe(false);
    });

    it("indicator() is a no-op", () => {
      const ctx = buildContext(baseParams);
      expect(() => ctx.indicator("rsi", 42)).not.toThrow();
    });

    it("getConditions() returns empty object", () => {
      const ctx = buildContext(baseParams);
      ctx.track("foo", true, 1, 2);
      expect(ctx.getConditions()).toEqual({});
    });

    it("getIndicators() returns empty object", () => {
      const ctx = buildContext(baseParams);
      ctx.indicator("bar", 99);
      expect(ctx.getIndicators()).toEqual({});
    });
  });

  describe("diagnosticsEnabled: true", () => {
    it("track() stores condition and returns passed", () => {
      const ctx = buildContext({ ...baseParams, diagnosticsEnabled: true });

      const result = ctx.track("L:breakout", true, 100, 95);
      expect(result).toBe(true);

      const conditions = ctx.getConditions();
      expect(conditions["L:breakout"]).toEqual({
        passed: true,
        value: 100,
        threshold: 95,
      });
    });

    it("track() stores failing condition", () => {
      const ctx = buildContext({ ...baseParams, diagnosticsEnabled: true });

      const result = ctx.track("L:adx_low", false, 30, 25);
      expect(result).toBe(false);

      expect(ctx.getConditions()["L:adx_low"]).toEqual({
        passed: false,
        value: 30,
        threshold: 25,
      });
    });

    it("indicator() stores values", () => {
      const ctx = buildContext({ ...baseParams, diagnosticsEnabled: true });

      ctx.indicator("rsi", 42);
      ctx.indicator("adx", 18);

      const indicators = ctx.getIndicators();
      expect(indicators).toEqual({ rsi: 42, adx: 18 });
    });

    it("accumulates multiple conditions from strategy call", () => {
      const ctx = buildContext({ ...baseParams, diagnosticsEnabled: true });

      ctx.track("L:breakout", true, 100, 95);
      ctx.track("L:adx_low", false, 30, 25);
      ctx.track("S:breakout", false, 100, 105);

      const conditions = ctx.getConditions();
      expect(Object.keys(conditions)).toHaveLength(3);
      expect(conditions["L:breakout"].passed).toBe(true);
      expect(conditions["L:adx_low"].passed).toBe(false);
      expect(conditions["S:breakout"].passed).toBe(false);
    });
  });
});
