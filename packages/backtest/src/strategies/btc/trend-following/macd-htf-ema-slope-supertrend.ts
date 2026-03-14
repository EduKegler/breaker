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
import {
  supertrend as supertrendIndicator,
  type SuperTrendResult,
} from "../../../indicators/supertrend.js";
import { ema } from "../../../indicators/ema.js";
import { slope } from "../../../indicators/slope.js";
import { atr } from "../../../indicators/atr.js";

const MS_1D = 86_400_000;

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed MACD slow / signal periods (standard 26/9). Only fast is tunable. */
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

interface MacdHtfEmaSlopeSupertrendParams {
  macdFast: StrategyParam;
  emaPeriod: StrategyParam;
  atrStopMult: StrategyParam;
  stExitPeriod: StrategyParam;
  stExitMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: MacdHtfEmaSlopeSupertrendParams = {
  macdFast: {
    value: 16,
    min: 8,
    max: 16,
    step: 2,
    optimizable: true,
    description: "MACD fast EMA period on 4H (slow=26, signal=9 fixed)",
  },
  emaPeriod: {
    value: 40,
    min: 10,
    max: 50,
    step: 5,
    optimizable: true,
    description: "Daily EMA period for slope regime filter",
  },
  atrStopMult: {
    value: 3.5,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  stExitPeriod: {
    value: 10,
    min: 7,
    max: 20,
    step: 1,
    optimizable: true,
    description: "SuperTrend ATR period for trailing exit on 4H",
  },
  stExitMult: {
    value: 2.5,
    min: 2.0,
    max: 5.0,
    step: 0.5,
    optimizable: true,
    description: "SuperTrend multiplier for trailing exit on 4H",
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

export function createMacdHtfEmaSlopeSupertrend(
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
  let stExitCache: SuperTrendResult | null = null;
  let dailyEmaCache: number[] | null = null;
  let dailyEmaSlopeCache: number[] | null = null;
  let dailyAtrCache: number[] | null = null;
  let dailyCandlesRef: Candle[] | null = null;

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
    name: "BTC 4H Trend Following — MACD HTF EMA Slope SuperTrend",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 55, "1d": 50 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes4h = candles.map((c) => c.c);

      // 4H MACD (source timeframe entry signal)
      macd4hCache = macdIndicator(
        closes4h,
        params.macdFast.value,
        MACD_SLOW,
        MACD_SIGNAL,
      );

      // SuperTrend on 4H for trailing exit
      stExitCache = supertrendIndicator(
        candles,
        params.stExitPeriod.value,
        params.stExitMult.value,
      );

      // Daily indicators (MACD alignment + EMA slope + ATR)
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyMacdCache = macdIndicator(
          dailyCloses,
          params.macdFast.value,
          MACD_SLOW,
          MACD_SIGNAL,
        );
        dailyEmaCache = ema(dailyCloses, params.emaPeriod.value);
        dailyEmaSlopeCache = slope(dailyEmaCache, 1);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, index, higherTimeframes: htf } = ctx;

      if (index < 55) return null;

      // ── SuperTrend diagnostics (log always, even during position) ──
      const stDir = stExitCache?.direction[index] ?? NaN;
      const stVal = stExitCache?.supertrend[index] ?? NaN;
      if (!isNaN(stDir)) ctx.indicator("stExitDir", stDir);
      if (!isNaN(stVal)) ctx.indicator("stExitValue", stVal);

      // Only signal when flat — exits handled by shouldExit()
      if (ctx.positionDirection !== null) return null;

      // ── 4H MACD (entry signal) ──
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

      // ── Daily candles — anti-lookahead ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 35) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 34) return null;

      // ── Daily MACD alignment (HTF filter — part of macd-htf entry) ──
      const dMacd =
        dailyMacdCache ??
        macdIndicator(
          dCandles.map((c) => c.c),
          params.macdFast.value,
          MACD_SLOW,
          MACD_SIGNAL,
        );
      const dailyMacdVal = dMacd.macd[dIdx];
      const dailySignalVal = dMacd.signal[dIdx];
      if (isNaN(dailyMacdVal) || isNaN(dailySignalVal)) return null;

      // ── Daily EMA slope regime filter ──
      const dEma =
        dailyEmaCache ??
        ema(
          dCandles.map((c) => c.c),
          params.emaPeriod.value,
        );
      const emaVal = dEma[dIdx];
      if (isNaN(emaVal)) return null;

      const dSlope = dailyEmaSlopeCache ?? slope(dEma, 1);
      const slopeVal = dSlope[dIdx];
      if (isNaN(slopeVal)) return null;

      // ── Daily ATR for hard SL ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = dAtr[dIdx];
      if (isNaN(atrVal)) return null;

      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("macd4h", macdLine);
      ctx.indicator("signal4h", signalLine);
      ctx.indicator("dailyMacd", dailyMacdVal);
      ctx.indicator("dailySignal", dailySignalVal);
      ctx.indicator("emaDaily", emaVal);
      ctx.indicator("emaSlopeDaily", slopeVal);
      ctx.indicator("atrDaily", atrVal);
      ctx.indicator("minHoldBars", MIN_HOLD_BARS);

      // ── LONG: 4H MACD cross + Daily MACD aligned + EMA slope up + price above EMA ──
      const longCross = ctx.track(
        "L:macd_cross",
        macdLine > signalLine && prevMacdLine <= prevSignalLine,
        macdLine,
        signalLine,
      );
      const longAlign = ctx.track(
        "L:daily_macd_align",
        dailyMacdVal > dailySignalVal,
        dailyMacdVal,
        dailySignalVal,
      );
      const longSlopeUp = ctx.track(
        "L:ema_slope_positive",
        slopeVal > 0,
        slopeVal,
        0,
      );
      const longAboveEma = ctx.track(
        "L:price_above_ema",
        close > emaVal,
        close,
        emaVal,
      );

      if (longCross && longAlign && longSlopeUp && longAboveEma) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "MACD HTF cross long (Daily MACD aligned + EMA slope uptrend)",
        };
      }

      // ── SHORT: 4H MACD cross + Daily MACD aligned + EMA slope down + price below EMA ──
      const shortCross = ctx.track(
        "S:macd_cross",
        macdLine < signalLine && prevMacdLine >= prevSignalLine,
        macdLine,
        signalLine,
      );
      const shortAlign = ctx.track(
        "S:daily_macd_align",
        dailyMacdVal < dailySignalVal,
        dailyMacdVal,
        dailySignalVal,
      );
      const shortSlopeDown = ctx.track(
        "S:ema_slope_negative",
        slopeVal < 0,
        slopeVal,
        0,
      );
      const shortBelowEma = ctx.track(
        "S:price_below_ema",
        close < emaVal,
        close,
        emaVal,
      );

      if (shortCross && shortAlign && shortSlopeDown && shortBelowEma) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "MACD HTF cross short (Daily MACD aligned + EMA slope downtrend)",
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

      // ── SuperTrend trailing exit on 4H ──
      const st = stExitCache;
      if (!st) return null;

      const currDir = st.direction[index];
      if (isNaN(currDir)) return null;

      ctx.indicator("stExitLevel", st.supertrend[index]);

      if (positionDirection === "long") {
        // SuperTrend bearish (price below support band) → exit long
        if (currDir === -1) {
          return { exit: true, comment: "SuperTrend exit (bearish)" };
        }
      }

      if (positionDirection === "short") {
        // SuperTrend bullish (price above resistance band) → exit short
        if (currDir === 1) {
          return { exit: true, comment: "SuperTrend exit (bullish)" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const st = stExitCache;
      if (!st) return null;

      // SuperTrend line is the trailing exit reference level
      const level = st.supertrend[index];
      return isNaN(level) ? null : level;
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
