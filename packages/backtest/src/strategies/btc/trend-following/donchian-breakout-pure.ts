import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import { donchian, type DonchianResult } from "../../../indicators/donchian.js";
import { atr } from "../../../indicators/atr.js";

const MIN_HOLD_BARS = 3;

interface DonchianBreakoutPureParams {
  entryBars: StrategyParam;
  exitBars: StrategyParam;
  atrStopMult: StrategyParam;
}

// 20 days × 6 bars/day = 120 bars on 4H
// 10 days × 6 bars/day = 60 bars on 4H
const DEFAULT_PARAMS: DonchianBreakoutPureParams = {
  entryBars: {
    value: 120,
    min: 36,
    max: 180,
    step: 6,
    optimizable: true,
    description: "Donchian entry lookback in 4H bars (120 = 20 days)",
  },
  exitBars: {
    value: 60,
    min: 18,
    max: 120,
    step: 6,
    optimizable: true,
    description: "Donchian exit lookback in 4H bars (60 = 10 days)",
  },
  atrStopMult: {
    value: 3.0,
    min: 2.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "ATR(14 daily) initial stop multiplier (safety net only)",
  },
};

export function createDonchianBreakoutPure(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Caches populated in init()
  let entryDcCache: DonchianResult | null = null;
  let exitDcCache: DonchianResult | null = null;
  let dailyAtrCache: number[] | null = null;
  let dailyCandlesRef: Candle[] | null = null;

  const MS_1D = 86_400_000;

  function findDailyValue(
    currentT: number,
    dailyRef: Candle[],
    values: number[],
  ): number {
    for (let j = dailyRef.length - 1; j >= 0; j--) {
      if (dailyRef[j].t + MS_1D <= currentT && !isNaN(values[j])) {
        return values[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 4H Trend Following — Donchian Breakout Pure",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 180, "1d": 20 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      dailyCandlesRef = higherTimeframes["1d"] ?? [];

      // Donchian on SOURCE (4H) candles — not Daily
      entryDcCache = donchian(candles, params.entryBars.value);
      exitDcCache = donchian(candles, params.exitBars.value);

      // ATR on Daily for stop loss only
      if (dailyCandlesRef.length > 0) {
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, index, candles } = ctx;

      // Donchian on 4H candles (previous bar values to avoid lookahead)
      const entryDc = entryDcCache ?? donchian(candles, params.entryBars.value);
      if (index < 1) return null;

      const dcUpper = entryDc.upper[index - 1];
      const dcLower = entryDc.lower[index - 1];
      if (isNaN(dcUpper) || isNaN(dcLower)) return null;

      const close = currentCandle.c;

      // ATR from Daily for stop distance
      const dCandles = dailyCandlesRef ?? ctx.higherTimeframes["1d"];
      if (!dCandles || dCandles.length < 15) return null;
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const stopDist = atrVal * params.atrStopMult.value;

      ctx.indicator("dcEntryUpper", dcUpper);
      ctx.indicator("dcEntryLower", dcLower);
      ctx.indicator("atrDaily", atrVal);

      // LONG: Close above 20-day highest high (QuantPedia)
      const longBreakout = ctx.track(
        "L:dc_breakout",
        close > dcUpper,
        close,
        dcUpper,
      );

      if (longBreakout) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Donchian breakout long (pure price)",
        };
      }

      // SHORT: Close below 20-day lowest low
      const shortBreakout = ctx.track(
        "S:dc_breakdown",
        close < dcLower,
        close,
        dcLower,
      );

      if (shortBreakout) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Donchian breakdown short (pure price)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const {
        currentCandle,
        candles,
        index,
        positionDirection,
        positionEntryBarIndex,
      } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // Donchian exit channel on 4H candles
      const exitDc = exitDcCache ?? donchian(candles, params.exitBars.value);
      if (index < 1) return null;

      const exitUpper = exitDc.upper[index - 1];
      const exitLower = exitDc.lower[index - 1];
      if (isNaN(exitUpper) || isNaN(exitLower)) return null;

      const close = currentCandle.c;

      // Exit LONG: Close below 10-day lowest low
      if (positionDirection === "long" && close < exitLower) {
        return { exit: true, comment: "Donchian exit (10-day low)" };
      }

      // Exit SHORT: Close above 10-day highest high
      if (positionDirection === "short" && close > exitUpper) {
        return { exit: true, comment: "Donchian exit (10-day high)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const exitDc = exitDcCache ?? donchian(candles, params.exitBars.value);
      if (index < 1) return null;

      if (positionDirection === "long") {
        const exitLower = exitDc.lower[index - 1];
        return isNaN(exitLower) ? null : exitLower;
      }

      if (positionDirection === "short") {
        const exitUpper = exitDc.upper[index - 1];
        return isNaN(exitUpper) ? null : exitUpper;
      }

      return null;
    },

    computeLevels(
      ctx: StrategyContext,
      direction: "long" | "short",
    ): {
      stopLoss: number;
      takeProfits: { price: number; pctOfPosition: number }[];
    } | null {
      const { currentCandle, higherTimeframes: htf } = ctx;

      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 15) return null;
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const stopDist = atrVal * params.atrStopMult.value;
      const close = currentCandle.c;

      return {
        stopLoss: direction === "long" ? close - stopDist : close + stopDist,
        takeProfits: [],
      };
    },
  };
}
