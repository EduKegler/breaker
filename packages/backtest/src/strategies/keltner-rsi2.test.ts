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
    if (trend === "up") price += 12;
    else if (trend === "down") price -= 12;
    else price = startPrice + Math.sin(i * 0.3) * 10;
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
    expect(strategy.params.adxThreshold.value).toBe(25);
    expect(strategy.params.maxTradesDay.value).toBe(3);
    expect(strategy.params.timeoutBars.value).toBe(8);
    expect(strategy.params.atrStopMult.value).toBe(3.0);
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

  it("generates long signal when close below KC lower + RSI2 oversold + volume spike", () => {
    const strategy = createKeltnerRsi2({ kcMultiplier: 1.5, rsi2Long: 30 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 10000;

    // Phase 1: stable period (~3 days = 288 bars) for indicators to warm up
    for (let i = 0; i < 288; i++) {
      price = 10000 + Math.sin(i * 0.1) * 15;
      candles.push(makeCandle(base + i * 900_000, price, 30, 100));
    }

    // Phase 2: sharp drop with volume spike — three consecutive down bars to get RSI2 < 30
    // and close below KC lower band, with volume > 1.5 * SMA(20)
    const dropBase = base + 288 * 900_000;
    candles.push(makeCandle(dropBase, price - 200, 30, 300));
    candles.push(makeCandle(dropBase + 900_000, price - 400, 30, 300));
    candles.push(makeCandle(dropBase + 2 * 900_000, price - 600, 30, 300));

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
        expect(signal.entryPrice).toBeTypeOf("number");
        expect(signal.takeProfits.length).toBeGreaterThan(0);
        expect(signal.takeProfits[0].pctOfPosition).toBe(1.0);
        expect(signal.comment).toBe("KC mean reversion long");
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
  });

  it("blocks long signal when volume is below threshold (quiet drift)", () => {
    const strategy = createKeltnerRsi2({ kcMultiplier: 1.5, rsi2Long: 30 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 10000;

    // Phase 1: stable period with moderate volume
    for (let i = 0; i < 288; i++) {
      price = 10000 + Math.sin(i * 0.1) * 15;
      candles.push(makeCandle(base + i * 900_000, price, 30, 100));
    }

    // Phase 2: sharp drop but LOW volume — below 1.5 * SMA(20)
    const dropBase = base + 288 * 900_000;
    candles.push(makeCandle(dropBase, price - 200, 30, 80));
    candles.push(makeCandle(dropBase + 900_000, price - 400, 30, 80));
    candles.push(makeCandle(dropBase + 2 * 900_000, price - 600, 30, 80));

    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h };
    strategy.init!(candles, htf);

    // Scan last bars — should find NO long signal (volume too low)
    for (let i = Math.max(candles.length - 10, 22); i < candles.length; i++) {
      const ctx = makeCtx(candles, i, htf);
      const signal = strategy.onCandle(ctx);
      expect(signal).toBeNull();
    }
  });

  it("generates short signal when close above KC upper + RSI2 overbought + volume spike", () => {
    const strategy = createKeltnerRsi2({ kcMultiplier: 1.5, rsi2Short: 70 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 10000;

    // Phase 1: stable period with moderate volume for indicators to warm up
    for (let i = 0; i < 288; i++) {
      price = 10000 + Math.sin(i * 0.1) * 15;
      candles.push(makeCandle(base + i * 900_000, price, 30, 100));
    }

    // Phase 2: sharp rise with high volume — three consecutive up bars to get RSI2 > 70
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
        expect(signal.entryPrice).toBeTypeOf("number");
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

  it("blocks signal when ADX on 1H exceeds adxThreshold (trending market)", () => {
    // ADX regime filter: MR must only enter in ranging markets (ADX < threshold)
    const strategy = createKeltnerRsi2({ kcMultiplier: 1.5, rsi2Long: 30, adxThreshold: 25 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];

    // Build 1H candles with a strong trend (high ADX)
    // Strong uptrend on 1H: each bar closes significantly higher
    const htf1h: Candle[] = [];
    let htfPrice = 10000;
    for (let i = 0; i < 40; i++) {
      htfPrice += 200; // Strong consistent trend → high ADX
      htf1h.push({
        t: base + i * 3_600_000,
        o: htfPrice - 150,
        h: htfPrice + 50,
        l: htfPrice - 200,
        c: htfPrice,
        v: 500,
        n: 100,
      });
    }

    // Build 15m candles: stable period then sharp drop (would trigger KC long without ADX gate)
    let price = htfPrice; // Match latest 1H price
    for (let i = 0; i < 288; i++) {
      price = htfPrice + Math.sin(i * 0.1) * 15;
      candles.push(makeCandle(base + 40 * 3_600_000 + i * 900_000, price, 30));
    }
    // Sharp drop to trigger KC long + RSI2 oversold
    const dropBase = base + 40 * 3_600_000 + 288 * 900_000;
    candles.push(makeCandle(dropBase, price - 200, 30));
    candles.push(makeCandle(dropBase + 900_000, price - 400, 30));
    candles.push(makeCandle(dropBase + 2 * 900_000, price - 600, 30));

    // Add more 1H candles covering the 15m range (continuing trend)
    let htfT = htf1h[htf1h.length - 1].t + 3_600_000;
    for (let i = 0; i < 80; i++) {
      htfPrice += 150;
      htf1h.push({
        t: htfT,
        o: htfPrice - 100,
        h: htfPrice + 50,
        l: htfPrice - 150,
        c: htfPrice,
        v: 500,
        n: 100,
      });
      htfT += 3_600_000;
    }

    const htf = { "1h": htf1h };
    strategy.init!(candles, htf);

    // Scan last bars — should find NO signal because ADX is high (trending)
    for (let i = Math.max(candles.length - 10, 22); i < candles.length; i++) {
      const ctx = makeCtx(candles, i, htf);
      const signal = strategy.onCandle(ctx);
      expect(signal).toBeNull();
    }
  });

  it("allows signal when ADX on 1H is below adxThreshold (ranging market)", () => {
    // Use a high threshold to make it easy to pass
    const strategy = createKeltnerRsi2({ kcMultiplier: 1.5, rsi2Long: 30, adxThreshold: 50 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];

    // Build 1H candles with a ranging market (low ADX)
    const htf1h: Candle[] = [];
    let htfPrice = 10000;
    for (let i = 0; i < 120; i++) {
      htfPrice = 10000 + Math.sin(i * 0.3) * 100; // Oscillating → low ADX
      htf1h.push({
        t: base + i * 3_600_000,
        o: htfPrice - 20,
        h: htfPrice + 30,
        l: htfPrice - 30,
        c: htfPrice,
        v: 500,
        n: 100,
      });
    }

    // Build 15m candles: stable period then sharp drop with volume spike
    let price = 10000;
    for (let i = 0; i < 288; i++) {
      price = 10000 + Math.sin(i * 0.1) * 15;
      candles.push(makeCandle(base + 120 * 3_600_000 + i * 900_000, price, 30, 100));
    }
    // Sharp drop with volume spike to trigger KC long + RSI2 oversold
    const dropBase = base + 120 * 3_600_000 + 288 * 900_000;
    candles.push(makeCandle(dropBase, price - 200, 30, 300));
    candles.push(makeCandle(dropBase + 900_000, price - 400, 30, 300));
    candles.push(makeCandle(dropBase + 2 * 900_000, price - 600, 30, 300));

    // Extend 1H candles to cover the 15m range (still ranging)
    let htfT = htf1h[htf1h.length - 1].t + 3_600_000;
    for (let i = 0; i < 80; i++) {
      htfPrice = 10000 + Math.sin((120 + i) * 0.3) * 100;
      htf1h.push({
        t: htfT,
        o: htfPrice - 20,
        h: htfPrice + 30,
        l: htfPrice - 30,
        c: htfPrice,
        v: 500,
        n: 100,
      });
      htfT += 3_600_000;
    }

    const htf = { "1h": htf1h };
    strategy.init!(candles, htf);

    // Scan last bars — should find a long signal (ADX is low, ranging market)
    let foundSignal = false;
    for (let i = Math.max(candles.length - 10, 22); i < candles.length; i++) {
      const ctx = makeCtx(candles, i, htf);
      const signal = strategy.onCandle(ctx);
      if (signal) {
        expect(signal.direction).toBe("long");
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
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

  describe("computeLevels", () => {
    it("returns KC midline TP and ATR-based SL for long", () => {
      const strategy = createKeltnerRsi2();
      const candles = generate15mCandles(60, 95000, "flat");
      const htf1h = generate1hCandles(candles);
      const htf = { "1h": htf1h };

      strategy.init!(candles, htf);
      const ctx = makeCtx(candles, candles.length - 1, htf);
      const levels = strategy.computeLevels!(ctx, "long");

      expect(levels).not.toBeNull();
      expect(levels!.stopLoss).toBeLessThan(candles[candles.length - 1].c);
      expect(levels!.takeProfits).toHaveLength(1);
      expect(levels!.takeProfits[0].pctOfPosition).toBe(1.0);
    });

    it("returns KC midline TP with 0.6 pct for short", () => {
      const strategy = createKeltnerRsi2();
      const candles = generate15mCandles(60, 95000, "flat");
      const htf1h = generate1hCandles(candles);
      const htf = { "1h": htf1h };

      strategy.init!(candles, htf);
      const ctx = makeCtx(candles, candles.length - 1, htf);
      const levels = strategy.computeLevels!(ctx, "short");

      expect(levels).not.toBeNull();
      expect(levels!.stopLoss).toBeGreaterThan(candles[candles.length - 1].c);
      expect(levels!.takeProfits).toHaveLength(1);
      expect(levels!.takeProfits[0].pctOfPosition).toBe(0.6);
    });

    it("works regardless of entry conditions (RSI, KC band)", () => {
      const strategy = createKeltnerRsi2();
      // Flat market — RSI will be around 50, price near KC mid (no entry condition met)
      const candles = generate15mCandles(60, 95000, "flat");
      const htf1h = generate1hCandles(candles);
      const htf = { "1h": htf1h };

      strategy.init!(candles, htf);
      const ctx = makeCtx(candles, candles.length - 1, htf);

      // onCandle returns null (no entry conditions met)
      const signal = strategy.onCandle(ctx);
      expect(signal).toBeNull();

      // computeLevels still returns levels
      const levels = strategy.computeLevels!(ctx, "long");
      expect(levels).not.toBeNull();
      expect(levels!.takeProfits).toHaveLength(1);
    });
  });
});
