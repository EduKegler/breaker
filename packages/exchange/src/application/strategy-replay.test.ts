import { describe, it, expect } from "vitest";
import { replayStrategy, type ReplaySignal } from "./strategy-replay.js";
import type { Strategy, Candle, CandleInterval } from "@breaker/backtest";

function makeCandles(count: number, startTs = 1700000000000, intervalMs = 900_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: startTs + i * intervalMs,
    o: 100 + i,
    h: 105 + i,
    l: 95 + i,
    c: 102 + i,
    v: 1000,
    n: 50,
  }));
}

function makeStrategy(signalAtIndices: number[]): Strategy {
  const signalSet = new Set(signalAtIndices);
  return {
    name: "test-strategy",
    params: {},
    onCandle(ctx) {
      if (signalSet.has(ctx.index)) {
        return {
          direction: "long",
          entryPrice: ctx.currentCandle.c,
          stopLoss: ctx.currentCandle.l,
          takeProfits: [],
          comment: `signal at ${ctx.index}`,
        };
      }
      return null;
    },
  };
}

describe("replayStrategy", () => {
  it("returns signals at correct candle timestamps", () => {
    const candles = makeCandles(50);
    const strategy = makeStrategy([10, 30]);

    const signals = replayStrategy({
      strategyFactory: () => strategy,
      candles,
      interval: "15m" as CandleInterval,
    });

    expect(signals).toHaveLength(2);
    expect(signals[0].t).toBe(candles[10].t);
    expect(signals[0].direction).toBe("long");
    expect(signals[0].entryPrice).toBe(candles[10].c);
    expect(signals[0].stopLoss).toBe(candles[10].l);
    expect(signals[1].t).toBe(candles[30].t);
  });

  it("returns empty array for no signals", () => {
    const candles = makeCandles(50);
    const strategy = makeStrategy([]);

    const signals = replayStrategy({
      strategyFactory: () => strategy,
      candles,
      interval: "15m" as CandleInterval,
    });

    expect(signals).toEqual([]);
  });

  it("returns empty array for empty candles", () => {
    const signals = replayStrategy({
      strategyFactory: () => makeStrategy([0]),
      candles: [],
      interval: "15m" as CandleInterval,
    });

    expect(signals).toEqual([]);
  });

  it("calls init when strategy has init method", () => {
    const candles = makeCandles(30);
    let initCalled = false;

    const strategy: Strategy = {
      name: "init-test",
      params: {},
      init(c, htf) {
        initCalled = true;
        expect(c).toBe(candles);
        expect(htf).toEqual({});
      },
      onCandle() {
        return null;
      },
    };

    replayStrategy({
      strategyFactory: () => strategy,
      candles,
      interval: "15m" as CandleInterval,
    });

    expect(initCalled).toBe(true);
  });

  it("aggregates higher timeframes when strategy requires them", () => {
    const candles = makeCandles(100);
    let htfKeys: string[] = [];

    const strategy: Strategy = {
      name: "htf-test",
      params: {},
      requiredTimeframes: ["1h"],
      init(_c, htf) {
        htfKeys = Object.keys(htf);
      },
      onCandle() {
        return null;
      },
    };

    replayStrategy({
      strategyFactory: () => strategy,
      candles,
      interval: "15m" as CandleInterval,
    });

    expect(htfKeys).toContain("1h");
  });

  it("handles short signals", () => {
    const candles = makeCandles(20);
    const strategy: Strategy = {
      name: "short-test",
      params: {},
      onCandle(ctx) {
        if (ctx.index === 5) {
          return {
            direction: "short",
            entryPrice: null,
            stopLoss: ctx.currentCandle.h,
            takeProfits: [],
            comment: "short entry",
          };
        }
        return null;
      },
    };

    const signals = replayStrategy({
      strategyFactory: () => strategy,
      candles,
      interval: "15m" as CandleInterval,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe("short");
    expect(signals[0].entryPrice).toBe(candles[5].c); // null → close
  });

  it("uses strategy factory for fresh instance", () => {
    const candles = makeCandles(20);
    let factoryCalls = 0;

    const signals = replayStrategy({
      strategyFactory: () => {
        factoryCalls++;
        return makeStrategy([5]);
      },
      candles,
      interval: "15m" as CandleInterval,
    });

    expect(factoryCalls).toBe(1);
    expect(signals).toHaveLength(1);
  });
});
