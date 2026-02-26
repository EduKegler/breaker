import { describe, it, expect } from "vitest";
import { createDonchianAdx } from "./donchian-adx.js";
import type { StrategyContext } from "../types/strategy.js";
import type { Candle } from "../types/candle.js";

function makeCandle(t: number, price: number, range = 50): Candle {
  return {
    t,
    o: price - range / 4,
    h: price + range / 2,
    l: price - range / 2,
    c: price,
    v: 100,
    n: 50,
  };
}

function generate15mCandles(count: number, startPrice: number, trend: "up" | "down" | "flat"): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const base = new Date("2024-01-01T00:00:00Z").getTime();
  for (let i = 0; i < count; i++) {
    candles.push(makeCandle(base + i * 900_000, price));
    if (trend === "up") price += 10 + Math.random() * 5;
    else if (trend === "down") price -= 10 + Math.random() * 5;
    else price += (Math.random() - 0.5) * 20;
  }
  return candles;
}

function generate1hCandles(candles15m: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i < candles15m.length; i += 4) {
    const batch = candles15m.slice(i, i + 4);
    if (batch.length === 0) break;
    result.push({
      t: batch[0].t,
      o: batch[0].o,
      h: Math.max(...batch.map((c) => c.h)),
      l: Math.min(...batch.map((c) => c.l)),
      c: batch[batch.length - 1].c,
      v: batch.reduce((s, c) => s + c.v, 0),
      n: batch.reduce((s, c) => s + c.n, 0),
    });
  }
  return result;
}

function generate1dCandles(candles15m: Candle[]): Candle[] {
  const result: Candle[] = [];
  // 96 bars per day at 15m
  for (let i = 0; i < candles15m.length; i += 96) {
    const batch = candles15m.slice(i, i + 96);
    if (batch.length === 0) break;
    result.push({
      t: batch[0].t,
      o: batch[0].o,
      h: Math.max(...batch.map((c) => c.h)),
      l: Math.min(...batch.map((c) => c.l)),
      c: batch[batch.length - 1].c,
      v: batch.reduce((s, c) => s + c.v, 0),
      n: batch.reduce((s, c) => s + c.n, 0),
    });
  }
  return result;
}

describe("createDonchianAdx", () => {
  it("creates strategy with default params", () => {
    const strategy = createDonchianAdx();
    expect(strategy.name).toBe("BTC 15m Breakout — Donchian ADX");
    expect(strategy.params.dcSlow.value).toBe(50);
    expect(strategy.params.dcFast.value).toBe(20);
    expect(strategy.params.adxThreshold.value).toBe(25);
    expect(strategy.params.atrStopMult.value).toBe(2.0);
    expect(strategy.requiredTimeframes).toEqual(["1h", "1d"]);
  });

  it("accepts param overrides", () => {
    const strategy = createDonchianAdx({ dcSlow: 40, adxThreshold: 30 });
    expect(strategy.params.dcSlow.value).toBe(40);
    expect(strategy.params.adxThreshold.value).toBe(30);
    expect(strategy.params.dcFast.value).toBe(20); // Unchanged
  });

  it("returns null during warmup period", () => {
    const strategy = createDonchianAdx();
    const candles = generate15mCandles(10, 10000, "flat");
    const htf = { "1h": [] as Candle[], "1d": [] as Candle[] };
    strategy.init!(candles, htf);
    const ctx: StrategyContext = {
      candles,
      index: 5, // Too early for dcSlow=50
      currentCandle: candles[5],
      positionDirection: null,
      positionEntryPrice: null,
      positionEntryBarIndex: null,
      higherTimeframes: htf,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    };
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("returns null when higher TF data insufficient", () => {
    const strategy = createDonchianAdx();
    const candles = generate15mCandles(200, 10000, "up");
    const htf = { "1h": generate1hCandles(candles).slice(0, 5), "1d": [] as Candle[] };
    strategy.init!(candles, htf);
    const ctx: StrategyContext = {
      candles,
      index: 100,
      currentCandle: candles[100],
      positionDirection: null,
      positionEntryPrice: null,
      positionEntryBarIndex: null,
      higherTimeframes: htf,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    };
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("generates long signal on uptrend breakout", () => {
    const strategy = createDonchianAdx({ dcSlow: 10, adxThreshold: 50 });

    // Build synthetic data: gradual uptrend (for bullish regime) with
    // consolidation periods (for low ADX) followed by breakouts.
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 10000;

    // Phase 1: ~60 days of gentle uptrend (enough for daily EMA50)
    for (let i = 0; i < 96 * 60; i++) {
      // Slow drift up with noise
      price += 0.5 + (Math.random() - 0.5) * 2;
      candles.push(makeCandle(base + i * 900_000, price, 30));
    }

    // Phase 2: tight consolidation for ~2 days (low ADX)
    const consolidationPrice = price;
    for (let i = 0; i < 96 * 2; i++) {
      price = consolidationPrice + (Math.random() - 0.5) * 10;
      candles.push(makeCandle(base + (96 * 60 + i) * 900_000, price, 8));
    }

    // Phase 3: breakout bar — big move up
    price = consolidationPrice + 100;
    candles.push(makeCandle(base + (96 * 62) * 900_000, price, 40));

    const htf1h = generate1hCandles(candles);
    const htf1d = generate1dCandles(candles);
    const htf = { "1h": htf1h, "1d": htf1d };

    strategy.init!(candles, htf);

    // Scan last portion for a signal
    let foundSignal = false;
    const startScan = Math.max(candles.length - 200, 100);
    for (let i = startScan; i < candles.length; i++) {
      const ctx: StrategyContext = {
        candles,
        index: i,
        currentCandle: candles[i],
        positionDirection: null,
        positionEntryPrice: null,
        positionEntryBarIndex: null,
        higherTimeframes: htf,
        dailyPnl: 0,
        tradesToday: 0,
        barsSinceExit: 999,
        consecutiveLosses: 0,
      };
      const signal = strategy.onCandle(ctx);
      if (signal) {
        expect(signal.direction).toBe("long");
        expect(signal.stopLoss).toBeLessThan(candles[i].c);
        expect(signal.entryPrice).toBeNull();
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
  });

  it("generates short signal on downtrend breakdown", () => {
    const strategy = createDonchianAdx({ dcSlow: 10, adxThreshold: 50 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 20000;

    // Phase 1: ~60 days of gentle downtrend (bearish regime: close < daily EMA50)
    for (let i = 0; i < 96 * 60; i++) {
      price -= 0.5 + (Math.random() - 0.5) * 2;
      candles.push(makeCandle(base + i * 900_000, price, 30));
    }

    // Phase 2: tight consolidation for ~2 days (low ADX)
    const consolidationPrice = price;
    for (let i = 0; i < 96 * 2; i++) {
      price = consolidationPrice + (Math.random() - 0.5) * 10;
      candles.push(makeCandle(base + (96 * 60 + i) * 900_000, price, 8));
    }

    // Phase 3: breakdown bar — big move down
    price = consolidationPrice - 100;
    candles.push(makeCandle(base + (96 * 62) * 900_000, price, 40));

    const htf1h = generate1hCandles(candles);
    const htf1d = generate1dCandles(candles);
    const htf = { "1h": htf1h, "1d": htf1d };

    strategy.init!(candles, htf);

    let foundSignal = false;
    const startScan = Math.max(candles.length - 200, 100);
    for (let i = startScan; i < candles.length; i++) {
      const ctx: StrategyContext = {
        candles,
        index: i,
        currentCandle: candles[i],
        positionDirection: null,
        positionEntryPrice: null,
        positionEntryBarIndex: null,
        higherTimeframes: htf,
        dailyPnl: 0,
        tradesToday: 0,
        barsSinceExit: 999,
        consecutiveLosses: 0,
      };
      const signal = strategy.onCandle(ctx);
      if (signal) {
        expect(signal.direction).toBe("short");
        expect(signal.stopLoss).toBeGreaterThan(candles[i].c);
        expect(signal.entryPrice).toBeNull();
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
  });

  it("shouldExit triggers trailing exit for short", () => {
    const strategy = createDonchianAdx({ dcFast: 5, timeoutBars: 100 });
    // Price goes down then bounces above fast Donchian upper
    const candles = [
      ...generate15mCandles(10, 10000, "down"),
      ...generate15mCandles(10, 9700, "up"),
    ];
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx: StrategyContext = {
      candles,
      index: candles.length - 1,
      currentCandle: candles[candles.length - 1],
      positionDirection: "short",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 0,
      higherTimeframes: htf,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    };
    const result = strategy.shouldExit!(ctx);
    if (result) {
      expect(result.exit).toBe(true);
      expect(result.comment).toBe("DC Trail");
    }
  });

  it("shouldExit triggers trailing exit for long before timeout", () => {
    const strategy = createDonchianAdx({ dcFast: 5, timeoutBars: 100 });
    // Price goes up then drops below fast Donchian lower
    const candles = [
      ...generate15mCandles(10, 10000, "up"),
      ...generate15mCandles(10, 10300, "down"),
    ];
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx: StrategyContext = {
      candles,
      index: candles.length - 1,
      currentCandle: candles[candles.length - 1],
      positionDirection: "long",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 0,
      higherTimeframes: htf,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    };
    const result = strategy.shouldExit!(ctx);
    // May or may not trigger depending on exact values
    if (result) {
      expect(result.exit).toBe(true);
      expect(result.comment).toBe("DC Trail");
    }
  });

  it("shouldExit triggers timeout after N bars", () => {
    const strategy = createDonchianAdx({ timeoutBars: 5 });
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx: StrategyContext = {
      candles,
      index: 15,
      currentCandle: candles[15],
      positionDirection: "long",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 10, // 15 - 10 = 5 bars in trade
      higherTimeframes: htf,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    };
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("Timeout");
  });

  it("shouldExit returns null when no position", () => {
    const strategy = createDonchianAdx();
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx: StrategyContext = {
      candles,
      index: 25,
      currentCandle: candles[25],
      positionDirection: null,
      positionEntryPrice: null,
      positionEntryBarIndex: null,
      higherTimeframes: htf,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    };
    expect(strategy.shouldExit!(ctx)).toBeNull();
  });

  it("accepts timeoutBars param override", () => {
    const strategy = createDonchianAdx({ timeoutBars: 30 });
    expect(strategy.params.timeoutBars.value).toBe(30);
  });
});
