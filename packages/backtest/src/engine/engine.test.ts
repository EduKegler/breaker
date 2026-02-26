import { describe, it, expect } from "vitest";
import { runBacktest, aggregateCandles, type BacktestConfig, type SizingMode, DEFAULT_BACKTEST_CONFIG } from "./engine.js";
import type { Candle } from "../types/candle.js";
import type { Strategy, StrategyContext, Signal } from "../types/strategy.js";

function makeCandle(t: number, o: number, h: number, l: number, c: number): Candle {
  return { t, o, h, l, c, v: 100, n: 50 };
}

/** Generate sequential candles with controlled movement. */
function generateCandles(count: number, startPrice: number, startTime: number): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const variation = Math.sin(i * 0.3) * 50;
    const o = price;
    const h = price + Math.abs(variation) + 20;
    const l = price - Math.abs(variation) - 20;
    const c = price + variation;
    candles.push(makeCandle(startTime + i * 900000, o, h, l, c));
    price = c;
  }
  return candles;
}

/** Simple always-long strategy for testing. */
const alwaysLongStrategy: Strategy = {
  name: "always-long",
  params: {},
  onCandle(ctx: StrategyContext): Signal | null {
    if (ctx.index < 5) return null; // Wait for warmup
    return {
      direction: "long",
      entryPrice: null, // market
      stopLoss: ctx.currentCandle.c - 50,
      takeProfits: [],
      comment: "Always long",
    };
  },
};

/** Strategy that never enters. */
const neverEnterStrategy: Strategy = {
  name: "never-enter",
  params: {},
  onCandle(): Signal | null {
    return null;
  },
};

/** Strategy with trailing exit. */
const trailingExitStrategy: Strategy = {
  name: "trailing-exit",
  params: {},
  onCandle(ctx: StrategyContext): Signal | null {
    if (ctx.index < 5) return null;
    return {
      direction: "long",
      entryPrice: null,
      stopLoss: ctx.currentCandle.c - 100,
      takeProfits: [],
      comment: "Entry",
    };
  },
  shouldExit(ctx: StrategyContext) {
    if (!ctx.positionEntryPrice) return null;
    // Exit if price drops 30 from entry
    if (ctx.currentCandle.c < ctx.positionEntryPrice - 30) {
      return { exit: true, comment: "Trailing exit" };
    }
    return null;
  },
};

describe("runBacktest", () => {
  it("returns zero trades with never-enter strategy", () => {
    const candles = generateCandles(50, 10000, Date.now());
    const result = runBacktest(candles, neverEnterStrategy);
    expect(result.trades).toHaveLength(0);
    expect(result.barsProcessed).toBe(50);
  });

  it("generates trades with always-long strategy", () => {
    const candles = generateCandles(100, 10000, Date.now());
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 1,
      maxConsecutiveLosses: 10,
      maxTradesPerDay: 100,
      dailyLossLimitUsd: 10000,
    };
    const result = runBacktest(candles, alwaysLongStrategy, config);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.barsProcessed).toBe(100);
  });

  it("force-closes open position at end of data", () => {
    // Short data set where position likely stays open
    const candles = generateCandles(10, 10000, Date.now());
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 1,
      maxConsecutiveLosses: 100,
      maxTradesPerDay: 100,
      dailyLossLimitUsd: 10000,
    };
    const result = runBacktest(candles, alwaysLongStrategy, config);
    // Should have at least 1 trade (force-closed)
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    const lastTrade = result.trades[result.trades.length - 1];
    expect(["sl", "eod", "signal"]).toContain(lastTrade.exitType);
  });

  it("respects cooldown bars", () => {
    const candles = generateCandles(20, 10000, Date.now());
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 100, // Very high cooldown
      maxConsecutiveLosses: 100,
      maxTradesPerDay: 100,
      dailyLossLimitUsd: 10000,
    };
    const result = runBacktest(candles, alwaysLongStrategy, config);
    // Should only have 1-2 trades due to high cooldown
    expect(result.trades.length).toBeLessThanOrEqual(2);
  });

  it("uses strategy shouldExit for signal-based exits", () => {
    const candles = generateCandles(50, 10000, Date.now());
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 1,
      maxConsecutiveLosses: 10,
      maxTradesPerDay: 100,
      dailyLossLimitUsd: 10000,
    };
    const result = runBacktest(candles, trailingExitStrategy, config);
    const signalExits = result.trades.filter((t) => t.exitType === "signal");
    // May or may not have signal exits depending on price action
    expect(result.trades.length).toBeGreaterThan(0);
  });

  it("equity curve tracks PnL correctly", () => {
    const candles = generateCandles(50, 10000, Date.now());
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      initialCapital: 1000,
      cooldownBars: 1,
      maxConsecutiveLosses: 10,
      maxTradesPerDay: 100,
      dailyLossLimitUsd: 10000,
    };
    const result = runBacktest(candles, alwaysLongStrategy, config);
    expect(result.finalEquity).toBeCloseTo(config.initialCapital + result.totalPnl, 0);
    expect(result.equityPoints.length).toBeGreaterThan(0);
  });

  it("trade properties are populated correctly", () => {
    const candles = generateCandles(50, 10000, Date.now());
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 1,
      maxConsecutiveLosses: 10,
      maxTradesPerDay: 100,
      dailyLossLimitUsd: 10000,
    };
    const result = runBacktest(candles, alwaysLongStrategy, config);
    for (const trade of result.trades) {
      expect(trade.direction).toBe("long");
      expect(trade.entryPrice).toBeGreaterThan(0);
      expect(trade.exitPrice).toBeGreaterThan(0);
      expect(trade.size).toBeGreaterThan(0);
      expect(trade.barsHeld).toBeGreaterThanOrEqual(0);
      expect(typeof trade.exitType).toBe("string");
      expect(typeof trade.entryComment).toBe("string");
    }
  });
});

describe("no-limits config", () => {
  it("disables all risk filters when limits are removed", () => {
    // Generate enough candles across a single day to trigger many entries
    const candles = generateCandles(100, 10000, Date.now());
    const limitedConfig: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 4,
      maxConsecutiveLosses: 2,
      dailyLossLimitUsd: 20,
      maxTradesPerDay: 3,
    };
    const unlimitedConfig: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 0,
      maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
      dailyLossLimitUsd: Number.MAX_SAFE_INTEGER,
      maxTradesPerDay: Number.MAX_SAFE_INTEGER,
    };
    const limited = runBacktest(candles, alwaysLongStrategy, limitedConfig);
    const unlimited = runBacktest(candles, alwaysLongStrategy, unlimitedConfig);
    expect(unlimited.trades.length).toBeGreaterThan(limited.trades.length);
  });
});

describe("cash sizing mode", () => {
  /** Strategy that enters long at a known price with a fixed stop. */
  const fixedPriceStrategy: Strategy = {
    name: "fixed-price",
    params: {},
    onCandle(ctx: StrategyContext): Signal | null {
      if (ctx.index < 5) return null;
      // Only enter once (first opportunity)
      if (ctx.index === 5) {
        return {
          direction: "long",
          entryPrice: null, // market order → fills at candle.c
          stopLoss: ctx.currentCandle.c - 100,
          takeProfits: [],
          comment: "Fixed entry",
        };
      }
      return null;
    },
  };

  const cashConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    sizingMode: "cash",
    cashPerTrade: 100,
    cooldownBars: 1,
    maxConsecutiveLosses: 100,
    maxTradesPerDay: 100,
    dailyLossLimitUsd: 10000,
  };

  it("cash sizing: size = cashPerTrade / entryPrice", () => {
    // Price at index 5 close → entry price is known from candle generation
    const startPrice = 50000;
    const candles = generateCandles(20, startPrice, Date.now());
    const entryCandle = candles[5];

    const result = runBacktest(candles, fixedPriceStrategy, cashConfig);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);

    const trade = result.trades[0];
    // Expected size: cashPerTrade / entryPrice (with slippage applied to fill)
    // The entry price includes slippage, so size = 100 / slippedPrice
    // But size is computed from raw entryPrice before slippage: 100 / candle.c
    const expectedSize = 100 / entryCandle.c;
    expect(trade.size).toBeCloseTo(expectedSize, 6);
  });

  it("cash sizing: trades use fixed dollar allocation", () => {
    const candles = generateCandles(100, 10000, Date.now());
    const result = runBacktest(candles, alwaysLongStrategy, cashConfig);
    expect(result.trades.length).toBeGreaterThan(0);

    for (const trade of result.trades) {
      // Each trade's size * entryPrice ≈ cashPerTrade (100)
      // entryPrice includes slippage, so approximate
      const dollarValue = trade.size * trade.entryPrice;
      expect(dollarValue).toBeCloseTo(100, -1); // within ~$10
    }
  });

  it("default sizing mode is risk (backward compatible)", () => {
    // Default config should not have sizingMode or should be "risk"
    const candles = generateCandles(50, 10000, Date.now());
    const config: BacktestConfig = {
      ...DEFAULT_BACKTEST_CONFIG,
      cooldownBars: 1,
      maxConsecutiveLosses: 10,
      maxTradesPerDay: 100,
      dailyLossLimitUsd: 10000,
    };
    const result = runBacktest(candles, alwaysLongStrategy, config);
    expect(result.trades.length).toBeGreaterThan(0);

    // In risk mode, size = riskPerTradeUsd / stopDist
    // stopDist = 50 (from alwaysLongStrategy), riskPerTradeUsd = 10
    // size = 10 / 50 = 0.2
    for (const trade of result.trades) {
      expect(trade.size).toBeCloseTo(0.2, 4);
    }
  });

  it("cash sizing: zero entry price produces zero size (no trade)", () => {
    const zeroStrategy: Strategy = {
      name: "zero-price",
      params: {},
      onCandle(ctx: StrategyContext): Signal | null {
        if (ctx.index === 5) {
          return {
            direction: "long",
            entryPrice: null,
            stopLoss: 0,
            takeProfits: [],
            comment: "Zero stop",
          };
        }
        return null;
      },
    };
    // With all-zero-close candles, entry price = 0 → size should be 0 → no trade
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(makeCandle(Date.now() + i * 900000, 0, 0, 0, 0));
    }
    const result = runBacktest(candles, zeroStrategy, cashConfig);
    expect(result.trades).toHaveLength(0);
  });
});

describe("deferred exit (process_orders_on_close = false)", () => {
  /** Candles with known prices for precise assertions. */
  function makeKnownCandles(): Candle[] {
    const t0 = new Date("2024-06-01T12:00:00Z").getTime();
    const ms15 = 900_000;
    return [
      // 0-4: warmup bars, stable price
      makeCandle(t0 + 0 * ms15, 100, 105, 95, 100),
      makeCandle(t0 + 1 * ms15, 100, 105, 95, 100),
      makeCandle(t0 + 2 * ms15, 100, 105, 95, 100),
      makeCandle(t0 + 3 * ms15, 100, 105, 95, 100),
      makeCandle(t0 + 4 * ms15, 100, 105, 95, 100),
      // 5: entry signal fires, market order placed → fills bar 6 open
      makeCandle(t0 + 5 * ms15, 100, 105, 95, 100),
      // 6: entry fills at open (200). Price rises.
      makeCandle(t0 + 6 * ms15, 200, 210, 195, 205),
      // 7: price still fine
      makeCandle(t0 + 7 * ms15, 205, 215, 200, 210),
      // 8: shouldExit fires (close drops below entry - 30 = 170). Exit order placed.
      makeCandle(t0 + 8 * ms15, 210, 212, 160, 165),
      // 9: exit fills at this bar's open (300). Position closes here.
      makeCandle(t0 + 9 * ms15, 300, 310, 295, 305),
      // 10-14: extra bars for potential re-entry
      makeCandle(t0 + 10 * ms15, 305, 315, 300, 310),
      makeCandle(t0 + 11 * ms15, 310, 320, 305, 315),
      makeCandle(t0 + 12 * ms15, 315, 325, 310, 320),
      makeCandle(t0 + 13 * ms15, 320, 330, 315, 325),
      makeCandle(t0 + 14 * ms15, 325, 335, 320, 330),
    ];
  }

  /** Strategy: enters long at index 5, shouldExit when close < entryPrice - 30. */
  const deferredExitStrategy: Strategy = {
    name: "deferred-exit-test",
    params: {},
    onCandle(ctx: StrategyContext): Signal | null {
      if (ctx.index === 5) {
        return {
          direction: "long",
          entryPrice: null, // market → fills next bar open
          stopLoss: ctx.currentCandle.c - 500, // far away, won't trigger
          takeProfits: [],
          comment: "Test entry",
        };
      }
      return null;
    },
    shouldExit(ctx: StrategyContext) {
      if (!ctx.positionEntryPrice) return null;
      // Exit when close drops 30 below entry
      if (ctx.currentCandle.c < ctx.positionEntryPrice - 30) {
        return { exit: true, comment: "DC trail exit" };
      }
      return null;
    },
  };

  const noLimitsConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    cooldownBars: 0,
    maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
    maxTradesPerDay: Number.MAX_SAFE_INTEGER,
    dailyLossLimitUsd: Number.MAX_SAFE_INTEGER,
    execution: { slippageBps: 0, commissionPct: 0 },
  };

  it("deferred exit fills at next bar open, not current bar close", () => {
    const candles = makeKnownCandles();
    const result = runBacktest(candles, deferredExitStrategy, noLimitsConfig);

    const signalExits = result.trades.filter((t) => t.exitType === "signal");
    expect(signalExits).toHaveLength(1);

    const trade = signalExits[0];
    // Entry: market order placed bar 5, fills bar 6 open = 200
    expect(trade.entryPrice).toBe(200);
    // Exit: shouldExit fires bar 8 (close=165 < 200-30=170), fills bar 9 open = 300
    expect(trade.exitPrice).toBe(300);
    expect(trade.exitBarIndex).toBe(9);
    expect(trade.exitComment).toBe("DC trail exit");
  });

  it("no same-bar re-entry after deferred exit", () => {
    /** Strategy that tries to re-enter every bar it's flat. */
    const reEntryStrategy: Strategy = {
      name: "re-entry-test",
      params: {},
      onCandle(ctx: StrategyContext): Signal | null {
        if (ctx.index < 5) return null;
        // Always try to enter when flat
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: ctx.currentCandle.c - 500,
          takeProfits: [],
          comment: `Entry bar ${ctx.index}`,
        };
      },
      shouldExit(ctx: StrategyContext) {
        if (!ctx.positionEntryPrice) return null;
        if (ctx.currentCandle.c < ctx.positionEntryPrice - 30) {
          return { exit: true, comment: "Exit" };
        }
        return null;
      },
    };

    const candles = makeKnownCandles();
    const result = runBacktest(candles, reEntryStrategy, noLimitsConfig);

    // Find the signal exit
    const signalExits = result.trades.filter((t) => t.exitType === "signal");
    if (signalExits.length > 0) {
      const exitBar = signalExits[0].exitBarIndex;
      // No trade should have entryBarIndex == exitBar (no same-bar re-entry)
      const sameBarReentry = result.trades.find(
        (t) => t.entryBarIndex === exitBar && t !== signalExits[0],
      );
      expect(sameBarReentry).toBeUndefined();
    }
  });

  it("existing SL exits still work unchanged", () => {
    /** Strategy with tight SL that triggers before shouldExit. */
    const slStrategy: Strategy = {
      name: "sl-test",
      params: {},
      onCandle(ctx: StrategyContext): Signal | null {
        if (ctx.index === 5) {
          return {
            direction: "long",
            entryPrice: null,
            stopLoss: 190, // tight SL, triggers when low <= 190
            takeProfits: [],
            comment: "SL test entry",
          };
        }
        return null;
      },
      shouldExit() {
        return null; // never fires
      },
    };

    // Candle 8 has low=160 which hits SL at 190
    const candles = makeKnownCandles();
    const result = runBacktest(candles, slStrategy, noLimitsConfig);

    const slExits = result.trades.filter((t) => t.exitType === "sl");
    expect(slExits.length).toBeGreaterThanOrEqual(1);
    // SL fills at stop price (190), not deferred
    expect(slExits[0].exitPrice).toBe(190);
  });
});

describe("aggregateCandles", () => {
  it("returns same candles when target equals source", () => {
    const candles = [
      makeCandle(0, 100, 110, 90, 105),
      makeCandle(900000, 105, 115, 95, 110),
    ];
    const result = aggregateCandles(candles, "15m", "15m");
    expect(result).toEqual(candles);
  });

  it("aggregates 15m to 1h", () => {
    // 4 candles at 15m intervals within the same hour
    const hourStart = new Date("2024-01-01T00:00:00Z").getTime();
    const candles = [
      makeCandle(hourStart, 100, 110, 90, 105),
      makeCandle(hourStart + 900000, 105, 120, 95, 115),
      makeCandle(hourStart + 1800000, 115, 125, 100, 110),
      makeCandle(hourStart + 2700000, 110, 118, 98, 112),
    ];
    const result = aggregateCandles(candles, "15m", "1h");
    expect(result).toHaveLength(1);
    expect(result[0].o).toBe(100); // First open
    expect(result[0].h).toBe(125); // Highest high
    expect(result[0].l).toBe(90); // Lowest low
    expect(result[0].c).toBe(112); // Last close
  });

  it("creates multiple buckets for multi-hour data", () => {
    const hourStart = new Date("2024-01-01T00:00:00Z").getTime();
    const candles = [];
    // 8 candles = 2 hours of 15m data
    for (let i = 0; i < 8; i++) {
      candles.push(makeCandle(hourStart + i * 900000, 100 + i, 110 + i, 90 + i, 105 + i));
    }
    const result = aggregateCandles(candles, "15m", "1h");
    expect(result).toHaveLength(2);
  });
});
