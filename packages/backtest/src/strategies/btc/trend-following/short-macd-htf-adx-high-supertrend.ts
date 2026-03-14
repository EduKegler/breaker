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
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";

const MS_1D = 86_400_000;

/**
 * Minimum hold period (KB rule 9, hard floor: 3 bars = 12h on 4H).
 * Trailing exit (SuperTrend flip) blocked during this period.
 * Hard SL and timeout are exempt.
 */
const MIN_HOLD_BARS = 3;

/** Fixed MACD signal period (standard 9). Not optimizable — saves a var slot. */
const MACD_SIGNAL_PERIOD = 9;

/** Fixed SuperTrend ATR lookback period for exit (standard 10). Saves a var slot. */
const ST_EXIT_PERIOD = 10;

interface ShortMacdHtfAdxHighSupertrendParams {
  macdFast: StrategyParam;
  macdSlow: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  stExitMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: ShortMacdHtfAdxHighSupertrendParams = {
  macdFast: {
    value: 12,
    min: 8,
    max: 16,
    step: 2,
    optimizable: true,
    description: "MACD fast EMA period on 4H",
  },
  macdSlow: {
    value: 26,
    min: 20,
    max: 34,
    step: 2,
    optimizable: true,
    description: "MACD slow EMA period on 4H",
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
  stExitMult: {
    value: 3.0,
    min: 2.0,
    max: 5.0,
    step: 0.5,
    optimizable: true,
    description: "SuperTrend ATR multiplier for 4H trailing exit (period=10 fixed)",
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

export function createShortMacdHtfAdxHighSupertrend(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let macdCache: MacdResult | null = null;
  let stExitCache: SuperTrendResult | null = null;
  let dailyAdxCache: AdxResult | null = null;
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
    name: "BTC 4H Trend Following — Short MACD HTF ADX High SuperTrend",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 80, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes4h = candles.map((c) => c.c);

      // MACD on 4H source candles
      macdCache = macdIndicator(
        closes4h,
        params.macdFast.value,
        params.macdSlow.value,
        MACD_SIGNAL_PERIOD,
      );

      // SuperTrend on 4H for trailing exit
      stExitCache = supertrendIndicator(
        candles,
        ST_EXIT_PERIOD,
        params.stExitMult.value,
      );

      // Daily indicators (ADX + ATR)
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, index, higherTimeframes: htf } = ctx;

      // Warmup: MACD needs ~43 bars (slow 34 + signal 9), use 80 for margin
      if (index < 80) return null;

      // ── MACD on 4H (cached from init) ──
      const m = macdCache;
      if (!m) return null;

      const currMacd = m.macd[index];
      const currSignal = m.signal[index];
      const prevMacd = m.macd[index - 1];
      const prevSignal = m.signal[index - 1];

      if (
        isNaN(currMacd) ||
        isNaN(currSignal) ||
        isNaN(prevMacd) ||
        isNaN(prevSignal)
      ) {
        return null;
      }

      // ── Daily candles — anti-lookahead ──
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
      ctx.indicator("macdLine", currMacd);
      ctx.indicator("macdSignal", currSignal);
      ctx.indicator("macdHist", currMacd - currSignal);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);
      ctx.indicator("minHoldBars", MIN_HOLD_BARS);

      // ── SHORT ONLY: MACD bearish crossover on 4H + ADX confirms trend ──
      // HTF filter = Daily ADX regime gate (no Daily MACD alignment — that killed
      // all 15 previous variants by making the triple gate too restrictive)
      const shortCross = ctx.track(
        "S:macd_cross_bear",
        prevMacd >= prevSignal && currMacd < currSignal,
        currMacd - currSignal,
        0,
      );
      const shortAdx = ctx.track(
        "S:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (shortCross && shortAdx) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "MACD bearish cross (ADX trend confirmed)",
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

      ctx.indicator("stExitDir", currDir);
      ctx.indicator("stExitValue", st.supertrend[index]);

      // Exit short when SuperTrend flips bullish (trend reversal)
      if (positionDirection === "short" && currDir === 1) {
        return { exit: true, comment: "SuperTrend exit (short)" };
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

      // Return SuperTrend line as resistance level for shorts (when bearish)
      if (positionDirection === "short" && st.direction[index] === -1) {
        const level = st.supertrend[index];
        return isNaN(level) ? null : level;
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
