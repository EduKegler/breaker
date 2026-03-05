import { describe, it, expect } from "vitest";
import { createDonchianAdx } from "./donchian-adx.js";
import type { StrategyContext } from "../../types/strategy.js";
import type { Candle } from "../../types/candle.js";

function makeCandle(t: number, price: number, range = 50, vol = 100): Candle {
  return {
    t,
    o: price - range / 4,
    h: price + range / 2,
    l: price - range / 2,
    c: price,
    v: vol,
    n: 50,
  };
}

const MS_15M = 900_000;
const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

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

function aggregate(candles15m: Candle[], barsPerGroup: number): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i < candles15m.length; i += barsPerGroup) {
    const batch = candles15m.slice(i, i + barsPerGroup);
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

function generate1hCandles(candles15m: Candle[]): Candle[] {
  return aggregate(candles15m, 4);
}

function generate4hCandles(candles15m: Candle[]): Candle[] {
  return aggregate(candles15m, 16);
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
    track: (_, p) => p,
    indicator: () => {},
    ...overrides,
  };
}

describe("createDonchianAdx", () => {
  it("creates strategy with default params", () => {
    const strategy = createDonchianAdx();
    expect(strategy.name).toBe("BTC 15m Breakout — Donchian ADX");
    expect(strategy.params.dcSlow.value).toBe(50);
    expect(strategy.params.dcFast.value).toBe(20);
    expect(strategy.params.adxThreshold.value).toBe(25);
    expect(strategy.params.atrStopMult.value).toBe(3);
    expect(strategy.params.volMult.value).toBe(1.5);
    expect(strategy.params.htfEmaPeriod.value).toBe(50);
    expect(strategy.params.timeoutBars.value).toBe(24);
    expect(strategy.requiredTimeframes).toEqual(["1h", "4h"]);
  });

  it("accepts param overrides", () => {
    const strategy = createDonchianAdx({ dcSlow: 40, adxThreshold: 30 });
    expect(strategy.params.dcSlow.value).toBe(40);
    expect(strategy.params.adxThreshold.value).toBe(30);
    expect(strategy.params.volMult.value).toBe(1.5); // unchanged
  });

  it("returns null during warmup period", () => {
    const strategy = createDonchianAdx();
    const candles = generate15mCandles(10, 10000, "flat");
    const htf = { "1h": [] as Candle[], "4h": [] as Candle[] };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 5, htf);
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("returns null when higher TF data insufficient", () => {
    const strategy = createDonchianAdx();
    const candles = generate15mCandles(200, 10000, "up");
    const htf = { "1h": generate1hCandles(candles).slice(0, 5), "4h": [] as Candle[] };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 100, htf);
    expect(strategy.onCandle(ctx)).toBeNull();
  });

  it("shouldExit triggers timeout after N bars", () => {
    const strategy = createDonchianAdx({ timeoutBars: 5, dcFast: 5 });
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles), "4h": generate4hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 15, htf, {
      positionDirection: "long",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 10,
    });
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("timeout");
  });

  it("shouldExit returns null when no position", () => {
    const strategy = createDonchianAdx();
    const candles = generate15mCandles(30, 10000, "flat");
    const htf = { "1h": generate1hCandles(candles), "4h": generate4hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 25, htf);
    expect(strategy.shouldExit!(ctx)).toBeNull();
  });

  it("shouldExit triggers DC Trail for long when close < dcFast lower", () => {
    const strategy = createDonchianAdx({ dcFast: 5, timeoutBars: 100 });
    const base = new Date("2024-01-01T00:00:00Z").getTime();

    // Build candles: flat then sharp drop
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(base + i * MS_15M, 10000));
    }
    // Sharp drop below DC fast lower
    candles.push(makeCandle(base + 60 * MS_15M, 9800, 50));

    const htf = { "1h": generate1hCandles(candles), "4h": generate4hCandles(candles) };
    strategy.init!(candles, htf);

    const ctx = makeCtx(candles, candles.length - 1, htf, {
      positionDirection: "long",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 50,
    });
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("DC Trail");
  });

  it("shouldExit triggers DC Trail for short when close > dcFast upper", () => {
    const strategy = createDonchianAdx({ dcFast: 5, timeoutBars: 100 });
    const base = new Date("2024-01-01T00:00:00Z").getTime();

    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(base + i * MS_15M, 10000));
    }
    // Sharp rally above DC fast upper
    candles.push(makeCandle(base + 60 * MS_15M, 10200, 50));

    const htf = { "1h": generate1hCandles(candles), "4h": generate4hCandles(candles) };
    strategy.init!(candles, htf);

    const ctx = makeCtx(candles, candles.length - 1, htf, {
      positionDirection: "short",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 50,
    });
    const result = strategy.shouldExit!(ctx);
    expect(result).not.toBeNull();
    expect(result!.exit).toBe(true);
    expect(result!.comment).toBe("DC Trail");
  });

  it("has 7 optimizable params (under 8 cap)", () => {
    const strategy = createDonchianAdx();
    const optimizable = Object.values(strategy.params).filter((p) => p.optimizable);
    expect(optimizable.length).toBe(7);
    expect(optimizable.length).toBeLessThanOrEqual(8);
  });

  it("getExitLevel returns null when no position", () => {
    const strategy = createDonchianAdx();
    const candles = generate15mCandles(70, 10000, "up");
    const htf = { "1h": generate1hCandles(candles), "4h": generate4hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 50, htf);
    expect(strategy.getExitLevel!(ctx)).toBeNull();
  });

  it("getExitLevel returns dcFast lower for long position", () => {
    const strategy = createDonchianAdx({ dcFast: 5 });
    const candles = generate15mCandles(70, 10000, "up");
    const htf = { "1h": generate1hCandles(candles), "4h": generate4hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 50, htf, {
      positionDirection: "long",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 40,
    });
    const level = strategy.getExitLevel!(ctx);
    expect(level).toBeTypeOf("number");
    expect(level!).toBeLessThan(candles[50].c);
  });

  it("getExitLevel returns dcFast upper for short position", () => {
    const strategy = createDonchianAdx({ dcFast: 5 });
    const candles = generate15mCandles(70, 10000, "down");
    const htf = { "1h": generate1hCandles(candles), "4h": generate4hCandles(candles) };
    strategy.init!(candles, htf);
    const ctx = makeCtx(candles, 50, htf, {
      positionDirection: "short",
      positionEntryPrice: 10000,
      positionEntryBarIndex: 40,
    });
    const level = strategy.getExitLevel!(ctx);
    expect(level).toBeTypeOf("number");
    expect(level!).toBeGreaterThan(candles[50].c);
  });

  it("computeLevels returns stop and TP for long direction", () => {
    const strategy = createDonchianAdx({ atrStopMult: 3 });
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(base + i * MS_15M, 10000));
    }
    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h, "4h": generate4hCandles(candles) };

    const ctx = makeCtx(candles, candles.length - 1, htf);
    const levels = strategy.computeLevels!(ctx, "long");
    expect(levels).not.toBeNull();
    expect(levels!.stopLoss).toBeLessThan(candles[candles.length - 1].c);
    expect(levels!.takeProfits.length).toBe(1);
    expect(levels!.takeProfits[0].pctOfPosition).toBe(50);
  });

  it("computeLevels returns stop and TP for short direction", () => {
    const strategy = createDonchianAdx({ atrStopMult: 3 });
    const base = new Date("2024-01-01T00:00:00Z").getTime();
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(makeCandle(base + i * MS_15M, 10000));
    }
    const htf1h = generate1hCandles(candles);
    const htf = { "1h": htf1h, "4h": generate4hCandles(candles) };

    const ctx = makeCtx(candles, candles.length - 1, htf);
    const levels = strategy.computeLevels!(ctx, "short");
    expect(levels).not.toBeNull();
    expect(levels!.stopLoss).toBeGreaterThan(candles[candles.length - 1].c);
    expect(levels!.takeProfits.length).toBe(1);
    expect(levels!.takeProfits[0].pctOfPosition).toBe(50);
  });

  it("accepts timeoutBars param override", () => {
    const strategy = createDonchianAdx({ timeoutBars: 30 });
    expect(strategy.params.timeoutBars.value).toBe(30);
  });
});
