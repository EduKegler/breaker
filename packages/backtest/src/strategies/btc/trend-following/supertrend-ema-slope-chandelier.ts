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
import {
  chandelier as chandelierIndicator,
  type ChandelierResult,
} from "../../../indicators/chandelier.js";
import { ema } from "../../../indicators/ema.js";
import { slope } from "../../../indicators/slope.js";
import { atr } from "../../../indicators/atr.js";

const MS_1D = 86_400_000;

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed Chandelier lookback period (standard 22 bars on 4H = ~3.7 days). Saves a var slot. */
const CHANDELIER_PERIOD = 22;

interface SupertrendEmaSlopeChandelierParams {
  stPeriod: StrategyParam;
  stMult: StrategyParam;
  emaPeriod: StrategyParam;
  atrStopMult: StrategyParam;
  chandelierMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: SupertrendEmaSlopeChandelierParams = {
  stPeriod: {
    value: 10,
    min: 7,
    max: 20,
    step: 1,
    optimizable: true,
    description: "SuperTrend ATR period on 4H",
  },
  stMult: {
    value: 3.0,
    min: 2.0,
    max: 4.0,
    step: 0.5,
    optimizable: true,
    description: "SuperTrend multiplier on 4H",
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
    value: 3,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  chandelierMult: {
    value: 3.0,
    min: 2.0,
    max: 5.0,
    step: 0.5,
    optimizable: true,
    description:
      "Chandelier ATR multiplier for trailing exit on 4H (period=22 fixed)",
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

export function createSupertrendEmaSlopeChandelier(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let stCache: SuperTrendResult | null = null;
  let chandelierCache: ChandelierResult | null = null;
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
    name: "BTC 4H Trend Following — SuperTrend EMA Slope Chandelier",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 100, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      // SuperTrend on 4H source candles
      stCache = supertrendIndicator(
        candles,
        params.stPeriod.value,
        params.stMult.value,
      );

      // Chandelier Exit on 4H for trailing exit
      chandelierCache = chandelierIndicator(
        candles,
        CHANDELIER_PERIOD,
        params.chandelierMult.value,
      );

      // Daily indicators (EMA slope + ATR)
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyEmaCache = ema(dailyCloses, params.emaPeriod.value);
        dailyEmaSlopeCache = slope(dailyEmaCache, 1);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes: htf } = ctx;

      if (index < 2) return null;

      // Only signal when flat — exits handled by shouldExit()
      if (ctx.positionDirection !== null) return null;

      // ── SuperTrend on source (4H) ──
      const st =
        stCache ??
        supertrendIndicator(
          candles.slice(0, index + 1),
          params.stPeriod.value,
          params.stMult.value,
        );

      const currDir = st.direction[index];
      const prevDir = st.direction[index - 1];
      if (isNaN(currDir) || isNaN(prevDir)) return null;

      // ── Daily candles — anti-lookahead ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 30) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 25) return null;

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
      ctx.indicator("stDir", currDir);
      ctx.indicator("stValue", st.supertrend[index]);
      ctx.indicator("emaDaily", emaVal);
      ctx.indicator("emaSlopeDaily", slopeVal);
      ctx.indicator("atrDaily", atrVal);

      // ── LONG: SuperTrend flips bullish + Daily EMA slope rising + price above EMA ──
      const longFlip = ctx.track(
        "L:st_flip_bull",
        prevDir === -1 && currDir === 1,
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

      if (longFlip && longSlopeUp && longAboveEma) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "SuperTrend bullish flip (EMA slope uptrend confirmed)",
        };
      }

      // ── SHORT: SuperTrend flips bearish + Daily EMA slope falling + price below EMA ──
      const shortFlip = ctx.track(
        "S:st_flip_bear",
        prevDir === 1 && currDir === -1,
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

      if (shortFlip && shortSlopeDown && shortBelowEma) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "SuperTrend bearish flip (EMA slope downtrend confirmed)",
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

      // ── Chandelier trailing exit on 4H ──
      const ch = chandelierCache;
      if (!ch) return null;

      if (positionDirection === "long") {
        const chandelierLevel = ch.longExit[index];
        if (isNaN(chandelierLevel)) return null;

        ctx.indicator("chandelierLongExit", chandelierLevel);

        if (ctx.currentCandle.c < chandelierLevel) {
          return { exit: true, comment: "Chandelier exit (long)" };
        }
      }

      if (positionDirection === "short") {
        const chandelierLevel = ch.shortExit[index];
        if (isNaN(chandelierLevel)) return null;

        ctx.indicator("chandelierShortExit", chandelierLevel);

        if (ctx.currentCandle.c > chandelierLevel) {
          return { exit: true, comment: "Chandelier exit (short)" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const ch = chandelierCache;
      if (!ch) return null;

      if (positionDirection === "long") {
        const level = ch.longExit[index];
        return isNaN(level) ? null : level;
      }

      if (positionDirection === "short") {
        const level = ch.shortExit[index];
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
