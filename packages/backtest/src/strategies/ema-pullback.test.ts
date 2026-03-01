import { describe, it, expect } from "vitest";
import { createEmaPullback } from "./ema-pullback.js";
import type { StrategyContext } from "../types/strategy.js";
import type { Candle } from "../types/candle.js";

const MS_15M = 900_000;
const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

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
    candles.push(makeCandle(base + i * MS_15M, price));
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

function generate4hCandles(candles15m: Candle[]): Candle[] {
  const result: Candle[] = [];
  // 16 bars of 15m per 4h
  for (let i = 0; i < candles15m.length; i += 16) {
    const batch = candles15m.slice(i, i + 16);
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
  overrides?: Partial<StrategyContext>,
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

describe("createEmaPullback", () => {
  it("creates strategy with default params", () => {
    const strategy = createEmaPullback();
    expect(strategy.name).toBe("EMA Pullback Continuation");
    expect(strategy.params.emaFast.value).toBe(9);
    expect(strategy.params.emaSlow.value).toBe(21);
    expect(strategy.params.rsiPeriod.value).toBe(7);
    expect(strategy.params.rsiOversold.value).toBe(40);
    expect(strategy.params.atrStopMult.value).toBe(2.0);
    expect(strategy.params.timeoutBars.value).toBe(30);
    expect(strategy.params.maxTradesDay.value).toBe(3);
    expect(strategy.requiredTimeframes).toEqual(["1h", "4h"]);
  });

  it("accepts param overrides", () => {
    const strategy = createEmaPullback({ emaFast: 12, rsiOversold: 35 });
    expect(strategy.params.emaFast.value).toBe(12);
    expect(strategy.params.rsiOversold.value).toBe(35);
    expect(strategy.params.emaSlow.value).toBe(21); // Unchanged
  });

  it("has correct param ranges for optimization", () => {
    const strategy = createEmaPullback();
    expect(strategy.params.emaFast).toMatchObject({ min: 5, max: 15, step: 1, optimizable: true });
    expect(strategy.params.emaSlow).toMatchObject({ min: 15, max: 30, step: 3, optimizable: true });
    expect(strategy.params.rsiPeriod).toMatchObject({ min: 5, max: 14, step: 1, optimizable: true });
    expect(strategy.params.rsiOversold).toMatchObject({ min: 30, max: 50, step: 5, optimizable: true });
    expect(strategy.params.atrStopMult).toMatchObject({ min: 1.5, max: 3.0, step: 0.5, optimizable: true });
    expect(strategy.params.timeoutBars).toMatchObject({ min: 15, max: 50, step: 5, optimizable: true });
    expect(strategy.params.maxTradesDay.optimizable).toBe(false);
  });

  it("returns null during warmup period", () => {
    const strategy = createEmaPullback();
    const candles = generate15mCandles(10, 150, "flat");
    const htf = { "1h": [] as Candle[], "4h": [] as Candle[] };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 5, htf);
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("returns null when 4H HTF data insufficient", () => {
    const strategy = createEmaPullback();
    const candles = generate15mCandles(200, 150, "up");
    const htf = { "1h": generate1hCandles(candles), "4h": [] as Candle[] };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 100, htf);
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("returns null when 1H HTF data insufficient", () => {
    const strategy = createEmaPullback();
    const candles = generate15mCandles(200, 150, "up");
    const htf4h = generate4hCandles(candles);
    const htf = { "1h": [] as Candle[], "4h": htf4h };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 100, htf);
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("generates long signal on bullish pullback recovery", () => {
    const strategy = createEmaPullback({ emaFast: 5, emaSlow: 10, rsiPeriod: 5, rsiOversold: 20 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 100;

    // Phase 1: strong uptrend for 30 days (enough for 4H EMA 21 warmup)
    for (let i = 0; i < 96 * 30; i++) {
      price += 0.3 + (Math.random() - 0.5) * 0.5;
      candles.push(makeCandle(base + i * MS_15M, price, 2));
    }

    // Phase 2: pullback — price dips below EMA fast for a few bars
    const peakPrice = price;
    for (let i = 0; i < 8; i++) {
      price = peakPrice - 5 - i * 0.5;
      candles.push(makeCandle(base + (96 * 30 + i) * MS_15M, price, 2));
    }

    // Phase 3: recovery — price bounces back above EMA fast
    for (let i = 0; i < 4; i++) {
      price = peakPrice + 2 + i * 0.5;
      candles.push(makeCandle(base + (96 * 30 + 8 + i) * MS_15M, price, 2));
    }

    const htf1h = generate1hCandles(candles);
    const htf4h = generate4hCandles(candles);
    const htf = { "1h": htf1h, "4h": htf4h };

    strategy.init!(candles, htf);

    let foundSignal = false;
    const startScan = Math.max(candles.length - 50, 100);
    for (let i = startScan; i < candles.length; i++) {
      const ctx = makeCtx(candles, i, htf);
      const signal = strategy.onCandle(ctx);
      if (signal) {
        expect(signal.direction).toBe("long");
        expect(signal.stopLoss).toBeLessThan(candles[i].c);
        expect(signal.entryPrice).toBeNull();
        expect(signal.takeProfits).toEqual([]);
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
  });

  it("generates short signal on bearish pullback recovery", () => {
    const strategy = createEmaPullback({ emaFast: 5, emaSlow: 10, rsiPeriod: 5, rsiOversold: 20 });

    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    let price = 500;

    // Phase 1: strong downtrend for 30 days
    for (let i = 0; i < 96 * 30; i++) {
      price -= 0.3 + (Math.random() - 0.5) * 0.5;
      candles.push(makeCandle(base + i * MS_15M, price, 2));
    }

    // Phase 2: pullback up — price rises above EMA fast
    const troughPrice = price;
    for (let i = 0; i < 8; i++) {
      price = troughPrice + 5 + i * 0.5;
      candles.push(makeCandle(base + (96 * 30 + i) * MS_15M, price, 2));
    }

    // Phase 3: resumption — price drops back below EMA fast
    for (let i = 0; i < 4; i++) {
      price = troughPrice - 2 - i * 0.5;
      candles.push(makeCandle(base + (96 * 30 + 8 + i) * MS_15M, price, 2));
    }

    const htf1h = generate1hCandles(candles);
    const htf4h = generate4hCandles(candles);
    const htf = { "1h": htf1h, "4h": htf4h };

    strategy.init!(candles, htf);

    let foundSignal = false;
    const startScan = Math.max(candles.length - 50, 100);
    for (let i = startScan; i < candles.length; i++) {
      const ctx = makeCtx(candles, i, htf);
      const signal = strategy.onCandle(ctx);
      if (signal) {
        expect(signal.direction).toBe("short");
        expect(signal.stopLoss).toBeGreaterThan(candles[i].c);
        expect(signal.entryPrice).toBeNull();
        expect(signal.takeProfits).toEqual([]);
        foundSignal = true;
        break;
      }
    }
    expect(foundSignal).toBe(true);
  });

  it("shouldExit triggers timeout after N bars", () => {
    const strategy = createEmaPullback({ timeoutBars: 5 });
    const candles = generate15mCandles(30, 150, "flat");
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 15, htf, {
      positionDirection: "long",
      positionEntryPrice: 150,
      positionEntryBarIndex: 10, // 15 - 10 = 5 bars in trade
    });
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("Timeout");
  });

  it("shouldExit returns null before timeout", () => {
    const strategy = createEmaPullback({ timeoutBars: 10 });
    const candles = generate15mCandles(30, 150, "flat");
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 15, htf, {
      positionDirection: "long",
      positionEntryPrice: 150,
      positionEntryBarIndex: 12, // 15 - 12 = 3 bars < 10
    });
    // Could be null or trailing exit — but not timeout
    const result = strategy.shouldExit!(ctx);
    if (result) {
      expect(result.comment).not.toBe("Timeout");
    }
  });

  it("shouldExit triggers trailing exit for long when close < prevEmaFast", () => {
    const strategy = createEmaPullback({ emaFast: 3, timeoutBars: 100 });
    // Uptrend then sharp drop
    const base = 1_000_000_000_000;
    const candles: Candle[] = [
      makeCandle(base, 100, 5),
      makeCandle(base + MS_15M, 105, 5),
      makeCandle(base + 2 * MS_15M, 110, 5),
      makeCandle(base + 3 * MS_15M, 115, 5),
      makeCandle(base + 4 * MS_15M, 120, 5),
      // Sharp drop: close well below EMA fast
      makeCandle(base + 5 * MS_15M, 80, 5),
    ];
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 5, htf, {
      positionDirection: "long",
      positionEntryPrice: 100,
      positionEntryBarIndex: 1,
    });
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("EMA Trail");
  });

  it("shouldExit triggers trailing exit for short when close > prevEmaFast", () => {
    const strategy = createEmaPullback({ emaFast: 3, timeoutBars: 100 });
    // Downtrend then sharp bounce
    const base = 1_000_000_000_000;
    const candles: Candle[] = [
      makeCandle(base, 200, 5),
      makeCandle(base + MS_15M, 195, 5),
      makeCandle(base + 2 * MS_15M, 190, 5),
      makeCandle(base + 3 * MS_15M, 185, 5),
      makeCandle(base + 4 * MS_15M, 180, 5),
      // Sharp bounce: close well above EMA fast
      makeCandle(base + 5 * MS_15M, 220, 5),
    ];
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 5, htf, {
      positionDirection: "short",
      positionEntryPrice: 200,
      positionEntryBarIndex: 1,
    });
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("EMA Trail");
  });

  it("shouldExit returns null when no position", () => {
    const strategy = createEmaPullback();
    const candles = generate15mCandles(30, 150, "flat");
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 25, htf);
    expect(strategy.shouldExit!(ctx)).toBeNull();
  });

  it("shouldExit returns null during insufficient warmup", () => {
    const strategy = createEmaPullback({ emaFast: 9, timeoutBars: 100 });
    const candles: Candle[] = Array.from({ length: 6 }, (_, i) =>
      makeCandle(1_000_000_000_000 + i * MS_15M, 150, 5),
    );
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 3, htf, {
      positionDirection: "long",
      positionEntryPrice: 150,
      positionEntryBarIndex: 1,
    });
    // barsInTrade = 2 < 100 so no timeout, and index 3 < emaFast+1=10
    expect(strategy.shouldExit!(ctx)).toBeNull();
  });

  it("getExitLevel returns emaFast[i-1] for long position", () => {
    const strategy = createEmaPullback({ emaFast: 3 });
    // Uptrend candles
    const base = 1_000_000_000_000;
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      price += 5;
      candles.push(makeCandle(base + i * MS_15M, price));
    }
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 15, htf, {
      positionDirection: "long",
      positionEntryPrice: 130,
      positionEntryBarIndex: 5,
    });
    const level = strategy.getExitLevel!(ctx);
    expect(level).toBeTypeOf("number");
    // EMA fast on uptrend should be below current price
    expect(level!).toBeLessThan(candles[15].c);
  });

  it("getExitLevel returns emaFast[i-1] for short position", () => {
    const strategy = createEmaPullback({ emaFast: 3 });
    // Downtrend candles
    const base = 1_000_000_000_000;
    const candles: Candle[] = [];
    let price = 300;
    for (let i = 0; i < 20; i++) {
      price -= 5;
      candles.push(makeCandle(base + i * MS_15M, price));
    }
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 15, htf, {
      positionDirection: "short",
      positionEntryPrice: 260,
      positionEntryBarIndex: 5,
    });
    const level = strategy.getExitLevel!(ctx);
    expect(level).toBeTypeOf("number");
    // EMA fast on downtrend should be above current price
    expect(level!).toBeGreaterThan(candles[15].c);
  });

  it("getExitLevel returns null when no position", () => {
    const strategy = createEmaPullback({ emaFast: 3 });
    const candles = generate15mCandles(20, 150, "up");
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 15, htf);
    expect(strategy.getExitLevel!(ctx)).toBeNull();
  });

  it("getExitLevel returns null during warmup", () => {
    const strategy = createEmaPullback({ emaFast: 20 });
    const candles = generate15mCandles(15, 150, "up");
    const htf = {} as Record<string, Candle[]>;
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 5, htf, {
      positionDirection: "long",
      positionEntryPrice: 150,
      positionEntryBarIndex: 0,
    });
    expect(strategy.getExitLevel!(ctx)).toBeNull();
  });

  it("onCandle works without init (fallback computation)", () => {
    const strategy = createEmaPullback();
    const candles = generate15mCandles(100, 150, "up");
    const htf1h = generate1hCandles(candles);
    const htf4h = generate4hCandles(candles);
    const htf = { "1h": htf1h, "4h": htf4h };
    // Don't call init, just call onCandle — should not throw
    const ctx = makeCtx(candles, 50, htf);
    expect(() => strategy.onCandle(ctx)).not.toThrow();
  });
});
