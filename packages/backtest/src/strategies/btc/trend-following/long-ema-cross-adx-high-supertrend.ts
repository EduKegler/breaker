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

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed SuperTrend ATR period for trailing exit (standard 10). Not optimizable to stay within 6-var cap. */
const ST_PERIOD = 10;

interface LongEmaCrossAdxHighSupertrendParams {
  emaFast: StrategyParam;
  emaSlow: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  stMultiplier: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: LongEmaCrossAdxHighSupertrendParams = {
  emaFast: {
    value: 20,
    min: 9,
    max: 30,
    step: 3,
    optimizable: true,
    description: "Fast EMA period on 4H",
  },
  emaSlow: {
    value: 50,
    min: 30,
    max: 80,
    step: 5,
    optimizable: true,
    description: "Slow EMA period on 4H",
  },
  adxThreshold: {
    value: 25,
    min: 25,
    max: 35,
    step: 1,
    optimizable: true,
    description: "ADX(14) Daily threshold — trend confirmed above this (KB floor: 25)",
  },
  atrStopMult: {
    value: 3.5,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  stMultiplier: {
    value: 3.0,
    min: 2.0,
    max: 5.0,
    step: 0.5,
    optimizable: true,
    description: "SuperTrend ATR multiplier for trailing exit on 4H",
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

export function createLongEmaCrossAdxHighSupertrend(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let fastEmaCache: number[] | null = null;
  let slowEmaCache: number[] | null = null;
  let stCache: SuperTrendResult | null = null;
  let dailyAdxCache: AdxResult | null = null;
  let dailyAtrCache: number[] | null = null;
  let dailyCandlesRef: Candle[] | null = null;

  /** Find last completed Daily value (anti-lookahead: candle must be fully closed). */
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
    name: "BTC 4H Trend Following — Long EMA Cross ADX SuperTrend",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 100, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes = candles.map((c) => c.c);
      fastEmaCache = ema(closes, params.emaFast.value);
      slowEmaCache = ema(closes, params.emaSlow.value);
      stCache = supertrendIndicator(candles, ST_PERIOD, params.stMultiplier.value);
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes: htf } = ctx;
      if (index < 2) return null;

      // ── EMA Cross on source (4H) ──
      const closes = candles.slice(0, index + 1).map((c) => c.c);
      const fastVals = fastEmaCache ?? ema(closes, params.emaFast.value);
      const slowVals = slowEmaCache ?? ema(closes, params.emaSlow.value);

      const currFast = fastVals[index];
      const currSlow = slowVals[index];
      const prevFast = fastVals[index - 1];
      const prevSlow = slowVals[index - 1];
      if (isNaN(currFast) || isNaN(currSlow) || isNaN(prevFast) || isNaN(prevSlow)) {
        return null;
      }

      // ── Daily ADX (completed bar only) ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 28) return null;

      const dAdx = dailyAdxCache ?? adxIndicator(dCandles, 14);
      const adxVal = findDailyValue(currentCandle.t, dCandles, dAdx.adx);
      if (isNaN(adxVal)) return null;

      // ── Daily ATR for initial stop ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const adxThresh = params.adxThreshold.value;
      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("emaFast", currFast);
      ctx.indicator("emaSlow", currSlow);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);

      // ── LONG ONLY: Fast EMA crosses above Slow EMA + ADX confirms trend ──
      const longCross = ctx.track(
        "L:ema_cross_bull",
        prevFast <= prevSlow && currFast > currSlow,
      );
      const longAdx = ctx.track(
        "L:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (longCross && longAdx) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "EMA cross bullish (ADX trend confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const {
        candles,
        index,
        positionDirection,
        positionEntryBarIndex,
      } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB §6)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Trailing exit blocked during minimum hold (KB §9)
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // SuperTrend flip against position = trailing exit
      const st =
        stCache ??
        supertrendIndicator(
          candles.slice(0, index + 1),
          ST_PERIOD,
          params.stMultiplier.value,
        );
      const currDir = st.direction[index];
      if (isNaN(currDir)) return null;

      if (positionDirection === "long" && currDir === -1) {
        return { exit: true, comment: "SuperTrend flip bearish" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // No trailing level during min hold period
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const st =
        stCache ??
        supertrendIndicator(
          candles.slice(0, index + 1),
          ST_PERIOD,
          params.stMultiplier.value,
        );
      const stLine = st.supertrend[index];
      if (isNaN(stLine)) return null;

      // SuperTrend line IS the trailing stop level
      return stLine;
    },

    computeLevels(
      ctx: StrategyContext,
      direction: "long" | "short",
    ): { stopLoss: number; takeProfits: { price: number; pctOfPosition: number }[] } | null {
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
