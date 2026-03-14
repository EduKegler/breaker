import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { slope } from "../../../indicators/slope.js";
import { atr } from "../../../indicators/atr.js";

const MS_1D = 86_400_000;

/** KB rule 9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed fast EMA period for MA crossover exit on 4H (saves a var slot). */
const MA_EXIT_FAST_PERIOD = 10;

interface LongEmaCrossEmaSlopeMaExitParams {
  emaFast: StrategyParam;
  emaSlow: StrategyParam;
  emaPeriod: StrategyParam;
  atrStopMult: StrategyParam;
  maExitSlow: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: LongEmaCrossEmaSlopeMaExitParams = {
  emaFast: {
    value: 10,
    min: 9,
    max: 30,
    step: 3,
    optimizable: true,
    description: "Fast EMA period on 4H for crossover entry",
  },
  emaSlow: {
    value: 35,
    min: 30,
    max: 80,
    step: 5,
    optimizable: true,
    description: "Slow EMA period on 4H for crossover entry",
  },
  emaPeriod: {
    value: 20,
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
  maExitSlow: {
    value: 25,
    min: 20,
    max: 60,
    step: 5,
    optimizable: true,
    description: "Slow EMA period for MA crossover exit on 4H (fast=10 fixed)",
  },
  timeoutBars: {
    value: 96,
    min: 60,
    max: 180,
    step: 6,
    optimizable: true,
    description: "Forced exit after N 4H bars (96 = 16 days)",
  },
};

export function createLongEmaCrossEmaSlopeMaExit(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let entryFastCache: number[] | null = null;
  let entrySlowCache: number[] | null = null;
  let exitFastCache: number[] | null = null;
  let exitSlowCache: number[] | null = null;
  let dailyEmaCache: number[] | null = null;
  let dailyEmaSlopeCache: number[] | null = null;
  let dailyAtrCache: number[] | null = null;
  let dailyCandlesRef: Candle[] | null = null;

  /** Find last completed Daily value (anti-lookahead: candle must be fully closed + non-NaN). */
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
    name: "BTC 4H Trend Following — Long EMA Cross EMA Slope MA Exit",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 50, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes = candles.map((c) => c.c);

      // EMA crossover on 4H (entry signal)
      entryFastCache = ema(closes, params.emaFast.value);
      entrySlowCache = ema(closes, params.emaSlow.value);

      // MA crossover exit on 4H (separate from entry EMAs)
      exitFastCache = ema(closes, MA_EXIT_FAST_PERIOD);
      exitSlowCache = ema(closes, params.maExitSlow.value);

      // Daily indicators (EMA slope regime + ATR for hard SL)
      dailyCandlesRef = higherTimeframes["1d"] ?? null;
      if (dailyCandlesRef && dailyCandlesRef.length > 0) {
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyEmaCache = ema(dailyCloses, params.emaPeriod.value);
        dailyEmaSlopeCache = slope(dailyEmaCache, 1);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, higherTimeframes: htf } = ctx;

      if (index < 2) return null;

      // Only signal when flat — exits handled by shouldExit()
      if (ctx.positionDirection !== null) return null;

      // ── 4H EMA crossover (entry signal) ──
      if (!entryFastCache || !entrySlowCache) return null;

      const currFast = entryFastCache[index];
      const currSlow = entrySlowCache[index];
      const prevFast = entryFastCache[index - 1];
      const prevSlow = entrySlowCache[index - 1];

      if (
        isNaN(currFast) ||
        isNaN(currSlow) ||
        isNaN(prevFast) ||
        isNaN(prevSlow)
      ) {
        return null;
      }

      // ── Daily candles — anti-lookahead via findDailyValue ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 28) return null;

      // ── Daily EMA slope regime filter ──
      const dEma =
        dailyEmaCache ??
        ema(
          dCandles.map((c) => c.c),
          params.emaPeriod.value,
        );
      const emaVal = findDailyValue(currentCandle.t, dCandles, dEma);
      if (isNaN(emaVal)) return null;

      const dSlope = dailyEmaSlopeCache ?? slope(dEma, 1);
      const slopeVal = findDailyValue(currentCandle.t, dCandles, dSlope);
      if (isNaN(slopeVal)) return null;

      // ── Daily ATR for hard SL ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("emaFast4h", currFast);
      ctx.indicator("emaSlow4h", currSlow);
      ctx.indicator("emaDaily", emaVal);
      ctx.indicator("emaSlopeDaily", slopeVal);
      ctx.indicator("atrDaily", atrVal);
      ctx.indicator("minHoldBars", MIN_HOLD_BARS);

      if (exitFastCache && exitSlowCache) {
        ctx.indicator("maExitFast", exitFastCache[index]);
        ctx.indicator("maExitSlow", exitSlowCache[index]);
      }

      // ── LONG ONLY: fast EMA crosses above slow + Daily EMA slope rising + price above EMA ──
      const longCross = ctx.track(
        "L:ema_cross_bull",
        prevFast <= prevSlow && currFast > currSlow,
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

      if (longCross && longSlopeUp && longAboveEma) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "EMA cross bullish (EMA slope uptrend confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB rule 6 — exempt from minHold)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Min hold period: trailing exit blocked for first MIN_HOLD_BARS bars (rule 9)
      // Hard SL handled by engine via computeLevels — exempt from minHold.
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // ── MA crossover exit on 4H (long positions only — death cross) ──
      if (!exitFastCache || !exitSlowCache) return null;

      const currFast = exitFastCache[index];
      const currSlow = exitSlowCache[index];
      const prevFast = exitFastCache[index - 1];
      const prevSlow = exitSlowCache[index - 1];

      if (
        isNaN(currFast) ||
        isNaN(currSlow) ||
        isNaN(prevFast) ||
        isNaN(prevSlow)
      ) {
        return null;
      }

      ctx.indicator("maExitFastLevel", currFast);
      ctx.indicator("maExitSlowLevel", currSlow);

      // Death cross: fast EMA crosses below slow EMA → exit long
      if (prevFast >= prevSlow && currFast < currSlow) {
        return { exit: true, comment: "MA death cross exit (long)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // Return slow exit EMA as reference level (crossover proxy)
      const slow = exitSlowCache?.[index] ?? NaN;
      return isNaN(slow) ? null : slow;
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
