import { describe, it, expect } from "vitest";
import { createKeltnerRsi2 } from "./keltner-rsi2.js";
import type { StrategyContext } from "../types/strategy.js";
import type { Candle } from "../types/candle.js";

function makeCandle(t: number, price: number, range = 50, volume = 100): Candle {
  return {
    t,
    o: price - range / 4,
    h: price + range / 2,
    l: price - range / 2,
    c: price,
    v: volume,
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

function makeCtx(
  candles: Candle[],
  index: number,
  htf: Record<string, Candle[]>,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    candles,
    index,
    currentCandle: candles[index],
    positionDirection: null,
    positionEntryPrice: null,
    positionEntryBarIndex: null,
    higherTimeframes: htf,
    dailyPnl: 0,
    tradesToday: 0,
    barsSinceExit: 999,
    consecutiveLosses: 0,
    ...overrides,
  };
}

describe("createKeltnerRsi2", () => {
  it("creates strategy with default params", () => {
    const strategy = createKeltnerRsi2();
    expect(strategy.name).toBe("BTC 15m Mean Reversion — Keltner RSI2");
    expect(strategy.params.kcMultiplier.value).toBe(2.0);
    expect(strategy.params.rsi2Long.value).toBe(20);
    expect(strategy.params.rsi2Short.value).toBe(80);
    expect(strategy.params.maxTradesDay.value).toBe(3);
    expect(strategy.params.timeoutBars.value).toBe(8);
    expect(strategy.params.atrStopMult.value).toBe(1.5);
    expect(strategy.requiredTimeframes).toEqual(["1h"]);
  });

  it("accepts param overrides", () => {
    const strategy = createKeltnerRsi2({ kcMultiplier: 2.5, rsi2Long: 15, atrStopMult: 2.0 });
    expect(strategy.params.kcMultiplier.value).toBe(2.5);
    expect(strategy.params.rsi2Long.value).toBe(15);
    expect(strategy.params.rsi2Short.value).toBe(80); // Unchanged
    expect(strategy.params.timeoutBars.value).toBe(8); // Unchanged
    expect(strategy.params.atrStopMult.value).toBe(2.0);
  });

  it("has required methods (init, onCandle, shouldExit)", () => {
    const strategy = createKeltnerRsi2();
    expect(typeof strategy.init).toBe("function");
    expect(typeof strategy.onCandle).toBe("function");
    expect(typeof strategy.shouldExit).toBe("function");
  });

  it("init pre-computes indicators without errors", () => {
    const strategy = createKeltnerRsi2();
    const candles = generate15mCandles(200, 10000, "flat");
    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h };
    expect(() => strategy.init!(candles, htf)).not.toThrow();
  });

  it("init handles empty candles without errors", () => {
    const strategy = createKeltnerRsi2();
    expect(() => strategy.init!([], { "1h": [] })).not.toThrow();
  });

  it("returns null during warmup period (index < 21)", () => {
    const strategy = createKeltnerRsi2();
    const candles = generate15mCandles(30, 10000, "flat");
    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 10, htf);
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("returns null when 1h HTF data is insufficient (< 15 bars)", () => {
    const strategy = createKeltnerRsi2();
    const candles = generate15mCandles(100, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles).slice(0, 5) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 50, htf);
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("returns null when 1h HTF is missing entirely", () => {
    const strategy = createKeltnerRsi2();
    const candles = generate15mCandles(100, 10000, "flat");
    strategy.init!(candles, {});
    const ctx = makeCtx(candles, 50, {});
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("generates long signal when close below KC lower + RSI2 oversold", () => {
    const strategy = createKeltnerRsi2({ kcMultiplier: 1.5, rsi2Long: 30 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 10000;

    // Phase 1: stable period (~3 days = 288 bars) for indicators to warm up
    for (let i = 0; i < 288; i++) {
      price = 10000 + (Math.random() - 0.5) * 40;
      candles.push(makeCandle(base + i * 900_000, price, 30));
    }

    // Phase 2: sharp drop — two consecutive down bars to get RSI2 < 30
    // and close below KC lower band
    const dropBase = base + 288 * 900_000;
    candles.push(makeCandle(dropBase, price - 200, 30));
    candles.push(makeCandle(dropBase + 900_000, price - 400, 30));
    candles.push(makeCandle(dropBase + 2 * 900_000, price - 600, 30));

    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h };
    strategy.init!(candles, htf);

    // Scan last bars for a long signal
    let foundSignal = false;
    for (let i = Math.max(candles.length - 10, 22); i < candles.length; i++) {
      const ctx = makeCtx(candles, i, htf);
      const signal = strategy.onCandle(ctx);
      if (signal) {
        expect(signal.direction).toBe("long");
        expect(signal.stopLoss).toBeLessThan(candles[i].c);
        expect(signal.entryPrice).toBeNull();
        expect(signal.takeProfits.length).toBeGreaterThan(0);
        expect(signal.takeProfits[0].pctOfPosition).toBe(1.0);
        expect(signal.comment).toBe("KC mean reversion long");
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
  });

  it("generates short signal when close above KC upper + RSI2 overbought + volume spike", () => {
    const strategy = createKeltnerRsi2({ kcMultiplier: 1.5, rsi2Short: 70 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 10000;

    // Phase 1: stable period with moderate volume for indicators to warm up
    for (let i = 0; i < 288; i++) {
      price = 10000 + (Math.random() - 0.5) * 40;
      candles.push(makeCandle(base + i * 900_000, price, 30, 100));
    }

    // Phase 2: sharp rise with high volume — two consecutive up bars to get RSI2 > 70
    // and close above KC upper band, with volume > 1.5 * SMA(20)
    const spikeBase = base + 288 * 900_000;
    candles.push(makeCandle(spikeBase, price + 200, 30, 300));
    candles.push(makeCandle(spikeBase + 900_000, price + 400, 30, 300));
    candles.push(makeCandle(spikeBase + 2 * 900_000, price + 600, 30, 300));

    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h };
    strategy.init!(candles, htf);

    // Scan last bars for a short signal
    let foundSignal = false;
    for (let i = Math.max(candles.length - 10, 22); i < candles.length; i++) {
      const ctx = makeCtx(candles, i, htf);
      const signal = strategy.onCandle(ctx);
      if (signal) {
        expect(signal.direction).toBe("short");
        expect(signal.stopLoss).toBeGreaterThan(candles[i].c);
        expect(signal.entryPrice).toBeNull();
        expect(signal.takeProfits.length).toBeGreaterThan(0);
        expect(signal.takeProfits[0].pctOfPosition).toBe(0.6);
        expect(signal.comment).toBe("KC mean reversion short");
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
  });

  it("shouldExit returns null when no position", () => {
    const strategy = createKeltnerRsi2();
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 25, htf);
    expect(strategy.shouldExit!(ctx)).toBeNull();
  });

  it("shouldExit returns null when positionEntryBarIndex is null", () => {
    const strategy = createKeltnerRsi2();
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 25, htf, {
      positionDirection: "long",
      positionEntryBarIndex: null,
    });
    expect(strategy.shouldExit!(ctx)).toBeNull();
  });

  it("shouldExit triggers timeout exit after N bars", () => {
    const strategy = createKeltnerRsi2({ timeoutBars: 4 });
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 25, htf, {
      positionDirection: "long",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 20,
    });
    // 25 - 20 = 5 bars >= 4 timeout
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("Timeout");
  });

  it("shouldExit does not trigger before timeout", () => {
    const strategy = createKeltnerRsi2({ timeoutBars: 8 });
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 25, htf, {
      positionDirection: "long",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 22,
    });
    // 25 - 22 = 3 bars < 8 timeout
    expect(strategy.shouldExit!(ctx)).toBeNull();
  });

  it("shouldExit works for short positions", () => {
    const strategy = createKeltnerRsi2({ timeoutBars: 4 });
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 25, htf, {
      positionDirection: "short",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 20,
    });
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("Timeout");
  });

  it("onCandle works without init (on-the-fly computation fallback)", () => {
    const strategy = createKeltnerRsi2();
    const candles = generate15mCandles(200, 10000, "flat");
    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h };
    // Do NOT call init — strategy should still work via on-the-fly fallback
    const ctx = makeCtx(candles, 50, htf);
    // Should not throw, and should return null or a valid signal
    const result = strategy.onCandle(ctx);
    expect(result === null || result.direction === "long" || result.direction === "short").toBe(true);
  });
});
