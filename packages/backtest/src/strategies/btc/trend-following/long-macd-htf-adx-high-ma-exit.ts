import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import {
  macd as macdIndicator,
  type MacdResult,
} from "../../../indicators/macd.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";
import { ema } from "../../../indicators/ema.js";

const MS_1D = 86_400_000;

/** Fixed MACD slow / signal periods (standard 26/9). Only fast is tunable. */
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

/** Fixed slow EMA period for MA-crossover exit. */
const MA_EXIT_SLOW = 21;

interface LongMacdHtfAdxHighMaExitParams {
  macdFast: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  maExitFast: StrategyParam;
  timeoutBars: StrategyParam;
  minHoldBars: StrategyParam;
}

const DEFAULT_PARAMS: LongMacdHtfAdxHighMaExitParams = {
  macdFast: {
    value: 12,
    min: 8,
    max: 20,
    step: 2,
    optimizable: true,
    description: "MACD fast EMA period on 4H (slow=26, signal=9 fixed)",
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
    value: 10,
    min: 8,
    max: 20,
    step: 2,
    optimizable: true,
    description:
      "Fast EMA period for MA crossover exit on 4H (slow=21 fixed). Death cross exits long.",
  },
  timeoutBars: {
    value: 90,
    min: 60,
    max: 150,
    step: 6,
    optimizable: true,
    description: "Forced exit after N 4H bars (90 = 15 days)",
  },
  minHoldBars: {
    value: 3,
    min: 3,
    max: 6,
    step: 1,
    optimizable: true,
    description:
      "Minimum bars before trailing exit can trigger (KB floor: 3). Hard SL always fires.",
  },
};

export function createLongMacdHtfAdxHighMaExit(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let macd4hCache: MacdResult | null = null;
  let dailyMacdCache: MacdResult | null = null;
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
    name: "BTC 4H Trend Following — Long MACD HTF ADX High MA Exit",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 50, "1d": 50 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes4h = candles.map((c) => c.c);
      macd4hCache = macdIndicator(
        closes4h,
        params.macdFast.value,
        MACD_SLOW,
        MACD_SIGNAL,
      );

      // EMA caches for MA crossover exit on 4H
      fastEmaCache = ema(closes4h, params.maExitFast.value);
      slowEmaCache = ema(closes4h, MA_EXIT_SLOW);

      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyMacdCache = macdIndicator(
          dailyCloses,
          params.macdFast.value,
          MACD_SLOW,
          MACD_SIGNAL,
        );
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, index, higherTimeframes: htf } = ctx;

      if (index < 35) return null;

      const macd4h = macd4hCache;
      if (!macd4h) return null;

      const macdLine = macd4h.macd[index];
      const signalLine = macd4h.signal[index];
      const prevMacdLine = macd4h.macd[index - 1];
      const prevSignalLine = macd4h.signal[index - 1];

      if (
        isNaN(macdLine) ||
        isNaN(signalLine) ||
        isNaN(prevMacdLine) ||
        isNaN(prevSignalLine)
      ) {
        return null;
      }

      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 35) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 34) return null;

      const dMacd =
        dailyMacdCache ??
        macdIndicator(
          dCandles.map((c) => c.c),
          params.macdFast.value,
          MACD_SLOW,
          MACD_SIGNAL,
        );
      const dailyMacdVal = dMacd.macd[dIdx];
      if (isNaN(dailyMacdVal)) return null;

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
      ctx.indicator("macd4h", macdLine);
      ctx.indicator("signal4h", signalLine);
      ctx.indicator("dailyMacd", dailyMacdVal);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);

      // LONG ONLY: 4H MACD cross above signal + Daily MACD > 0 (bullish regime) + ADX
      const longCross = ctx.track(
        "L:macd_cross",
        macdLine > signalLine && prevMacdLine <= prevSignalLine,
        macdLine,
        signalLine,
      );
      const longAlign = ctx.track(
        "L:daily_macd_bullish",
        dailyMacdVal > 0,
        dailyMacdVal,
        0,
      );
      const longAdx = ctx.track(
        "L:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (longCross && longAlign && longAdx) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "MACD HTF cross long (Daily bullish + ADX confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB rule 6)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Trailing exit blocked during minimum hold (KB rule 9)
      if (barsInTrade < params.minHoldBars.value) return null;

      // MA crossover exit on 4H: death cross = fast EMA below slow EMA
      const closes4h = candles.map((c) => c.c);
      const fastVals = fastEmaCache ?? ema(closes4h, params.maExitFast.value);
      const slowVals = slowEmaCache ?? ema(closes4h, MA_EXIT_SLOW);

      const currFast = fastVals[index];
      const currSlow = slowVals[index];
      const prevFast = fastVals[index - 1];
      const prevSlow = slowVals[index - 1];

      if (isNaN(currFast) || isNaN(currSlow) || isNaN(prevFast) || isNaN(prevSlow)) {
        return null;
      }

      ctx.indicator("exitFastEma", currFast);
      ctx.indicator("exitSlowEma", currSlow);

      // Exit long on death cross: fast EMA crosses below slow EMA
      if (positionDirection === "long" && prevFast >= prevSlow && currFast < currSlow) {
        return { exit: true, comment: "MA death cross exit (long)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < params.minHoldBars.value) return null;

      // Return the slow EMA as the trailing support level for longs
      const closes4h = candles.map((c) => c.c);
      const slowVals = slowEmaCache ?? ema(closes4h, MA_EXIT_SLOW);
      const level = slowVals[index];

      if (positionDirection === "long" && !isNaN(level)) {
        return level;
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
