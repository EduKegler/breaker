import { describe, it, expect } from "vitest";
import { diagnoseSignal, type DiagnoseResult } from "./diagnose-signal.js";
import { buildContext } from "@breaker/backtest";
import type { Candle, StrategyContext } from "@breaker/backtest";

function makeCandle(i: number, close: number): Candle {
  return {
    t: 1700000000000 + i * 900_000,
    o: close - 1,
    h: close + 2,
    l: close - 3,
    c: close,
    v: 1000,
    n: 0,
  };
}

function buildCtx(opts: {
  candles: Candle[];
  index: number;
  higherTimeframes?: Record<string, Candle[]>;
}): StrategyContext {
  return buildContext({
    candles: opts.candles,
    index: opts.index,
    position: null,
    higherTimeframes: opts.higherTimeframes ?? {},
    dailyPnl: 0,
    tradesToday: 0,
    barsSinceExit: 999,
  });
}

describe("diagnoseSignal", () => {
  it("returns basic diagnostics for unknown strategy", () => {
    const candles = Array.from({ length: 30 }, (_, i) => makeCandle(i, 100 + i));
    const ctx = buildCtx({ candles, index: 29 });
    const result = diagnoseSignal(ctx, "unknown-strategy", "15m");

    expect(result.indicators.close).toBe(129);
    expect(result.indicators.index).toBe(29);
    expect(result.conditions).toEqual({});
  });

  it("diagnoses ema-pullback with all conditions", () => {
    // 15m candles — base timestamp far enough that HTF candles are all completed
    const baseTs = 1700000000000;
    const candles: Candle[] = [];
    for (let i = 0; i < 50; i++) {
      candles.push(makeCandle(i, 100 + i * 0.5));
    }

    // 4H candles — all WELL before the 15m candles so they are "completed"
    // Need >= 22 for EMA 21 validity
    const htf4h: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      htf4h.push({
        t: baseTs - (30 - i) * 14_400_000, // ends well before current candle
        o: 90 + i,
        h: 95 + i,
        l: 85 + i,
        c: 90 + i,
        v: 5000,
        n: 0,
      });
    }

    // 1H candles — same: all completed before current 15m candle
    const htf1h: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      htf1h.push({
        t: baseTs - (30 - i) * 3_600_000,
        o: 95 + i * 0.2,
        h: 98 + i * 0.2,
        l: 92 + i * 0.2,
        c: 96 + i * 0.2,
        v: 3000,
        n: 0,
      });
    }

    const ctx = buildCtx({
      candles,
      index: candles.length - 1,
      higherTimeframes: { "4h": htf4h, "1h": htf1h },
    });

    const result = diagnoseSignal(ctx, "ema-pullback", "15m");

    // Should have all ema-pullback indicators
    expect(result.indicators).toHaveProperty("close");
    expect(result.indicators).toHaveProperty("prevClose");
    expect(result.indicators).toHaveProperty("emaFast");
    expect(result.indicators).toHaveProperty("emaSlow");
    expect(result.indicators).toHaveProperty("rsi");
    expect(result.indicators).toHaveProperty("prevEmaFast");

    // Should have long and short condition groups
    const conditionKeys = Object.keys(result.conditions);
    expect(conditionKeys.length).toBeGreaterThan(0);

    // Each condition should have passed, value, threshold
    for (const key of conditionKeys) {
      const cond = result.conditions[key];
      expect(cond).toHaveProperty("passed");
      expect(typeof cond.passed).toBe("boolean");
      expect(cond).toHaveProperty("value");
      expect(cond).toHaveProperty("threshold");
    }
  });

  it("reports NaN indicators when warmup insufficient", () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(i, 100));
    const ctx = buildCtx({ candles, index: 4 });
    const result = diagnoseSignal(ctx, "ema-pullback", "15m");

    // With only 5 candles and no HTFs, indicators should be NaN
    expect(result.indicators.ema21_4h).toBeNaN();
    expect(result.indicators.atr1h).toBeNaN();
  });
});
