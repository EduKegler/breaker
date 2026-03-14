import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import {
  supertrend as supertrendIndicator,
  type SuperTrendResult,
} from "../../../indicators/supertrend.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";
import { ema } from "../../../indicators/ema.js";

const MS_1D = 86_400_000;

/**
 * Minimum hold period (KB rule 9, hard floor: 3 bars = 12h on 4H).
 * Trailing exit (MA cross) blocked during this period.
 * Hard SL and timeout are exempt.
 */
const MIN_HOLD_BARS = 3;

/** Fixed SuperTrend ATR lookback period on 4H (standard 10). */
const ST_PERIOD = 10;

interface SupertrendAdxHighMaExitParams {
  stMultiplier: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  maExitFast: StrategyParam;
  maExitSlow: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: SupertrendAdxHighMaExitParams = {
  stMultiplier: {
    value: 3,
    min: 2,
    max: 5,
    step: 0.5,
    optimizable: true,
    description: "SuperTrend ATR multiplier for 4H entry signal",
  },
  adxThreshold: {
    value: 25,
    min: 25,
    max: 35,
    step: 1,
    optimizable: true,
    description:
      "ADX(14) Daily threshold — trend confirmed above this (KB floor: 25)",
  },
  atrStopMult: {
    value: 4.0,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  maExitFast: {
    value: 9,
    min: 9,
    max: 30,
    step: 3,
    optimizable: true,
    description: "Fast EMA period on 4H for MA crossover exit",
  },
  maExitSlow: {
    value: 50,
    min: 30,
    max: 80,
    step: 5,
    optimizable: true,
    description: "Slow EMA period on 4H for MA crossover exit",
  },
  timeoutBars: {
    value: 120,
    min: 60,
    max: 180,
    step: 6,
    optimizable: true,
    description: "Forced exit after N 4H bars (120 = 20 days)",
  },
};

export function createSupertrendAdxHighMaExit(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let st4hCache: SuperTrendResult | null = null;
  let dailyAdxCache: AdxResult | null = null;
  let dailyAtrCache: number[] | null = null;
  let dailyCandlesRef: Candle[] | null = null;
  let fastEmaCache: number[] | null = null;
  let slowEmaCache: number[] | null = null;

  /** Find index of last fully-closed Daily candle (anti-lookahead). */
  function findLastDailyIdx(currentT: number, dailyRef: Candle[]): number {
    for (let j = dailyRef.length - 1; j >= 0; j--) {
      if (dailyRef[j].t + MS_1D <= currentT) {
        return j;
      }
    }
    return -1;
  }

  return {
    name: "BTC 4H Trend Following — SuperTrend ADX High MA Exit",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 80, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes4h = candles.map((c) => c.c);

      st4hCache = supertrendIndicator(candles, ST_PERIOD, params.stMultiplier.value);
      fastEmaCache = ema(closes4h, params.maExitFast.value);
      slowEmaCache = ema(closes4h, params.maExitSlow.value);

      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, index, higherTimeframes: htf } = ctx;

      // Warmup: EMA slow up to 80 bars, SuperTrend ~10 bars
      if (index < 80) return null;

      const st = st4hCache;
      if (!st) return null;

      const dir = st.direction[index];
      const prevDir = st.direction[index - 1];
      if (isNaN(dir) || isNaN(prevDir)) return null;

      // Daily candles — anti-lookahead
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 15) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 14) return null;

      const dAdx = dailyAdxCache ?? adxIndicator(dCandles, 14);
      const adxVal = dAdx.adx[dIdx];
      if (isNaN(adxVal)) return null;

      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = dAtr[dIdx];
      if (isNaN(atrVal)) return null;

      const adxThresh = params.adxThreshold.value;
      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("stDir", dir);
      ctx.indicator("stLine", st.supertrend[index]);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);
      ctx.indicator("minHoldBars", MIN_HOLD_BARS);

      // LONG: SuperTrend flips bullish (direction -1 -> 1) + ADX gate
      const longFlip = ctx.track(
        "L:st_flip",
        dir === 1 && prevDir === -1,
        dir,
        1,
      );
      const longAdx = ctx.track(
        "L:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (longFlip && longAdx) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "SuperTrend flip long (ADX confirmed)",
        };
      }

      // SHORT: SuperTrend flips bearish (direction 1 -> -1) + ADX gate
      const shortFlip = ctx.track(
        "S:st_flip",
        dir === -1 && prevDir === 1,
        dir,
        -1,
      );
      const shortAdx = ctx.track(
        "S:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (shortFlip && shortAdx) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "SuperTrend flip short (ADX confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { positionDirection, positionEntryBarIndex, index } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB rule 6 — exempt from minHold)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Min hold period: trailing exit blocked for first MIN_HOLD_BARS bars (rule 9)
      // Hard SL handled by engine via computeLevels — exempt from minHold.
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // MA crossover exit
      const fastEma = fastEmaCache?.[index] ?? NaN;
      const slowEma = slowEmaCache?.[index] ?? NaN;
      const prevFastEma = fastEmaCache?.[index - 1] ?? NaN;
      const prevSlowEma = slowEmaCache?.[index - 1] ?? NaN;

      if (
        isNaN(fastEma) ||
        isNaN(slowEma) ||
        isNaN(prevFastEma) ||
        isNaN(prevSlowEma)
      ) {
        return null;
      }

      ctx.indicator("exitFastEma", fastEma);
      ctx.indicator("exitSlowEma", slowEma);

      // Long exit: death cross (fast EMA crosses below slow EMA)
      if (
        positionDirection === "long" &&
        fastEma < slowEma &&
        prevFastEma >= prevSlowEma
      ) {
        return { exit: true, comment: "MA crossover exit (long)" };
      }

      // Short exit: golden cross (fast EMA crosses above slow EMA)
      if (
        positionDirection === "short" &&
        fastEma > slowEma &&
        prevFastEma <= prevSlowEma
      ) {
        return { exit: true, comment: "MA crossover exit (short)" };
      }

      return null;
    },

    getExitLevel(_ctx: StrategyContext): number | null {
      // MA crossover exit is a condition, not a price level
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

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 0) return null;
      const atrVal = dAtr[dIdx];
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
