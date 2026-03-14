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
  adx as adxIndicator,
  type AdxResult,
} from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";

const MS_1D = 86_400_000;

interface SupertrendAdxHighTimeoutParams {
  stPeriod: StrategyParam;
  stMult: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
  minHoldBars: StrategyParam;
}

const DEFAULT_PARAMS: SupertrendAdxHighTimeoutParams = {
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
    description: "SuperTrend multiplier on 4H (controls band width)",
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
      "Minimum bars before timeout exit can trigger (KB floor: 3). Hard SL always fires.",
  },
};

export function createSupertrendAdxHighTimeout(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
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
    name: "BTC 4H Trend Following — SuperTrend ADX Timeout",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 100, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      stCache = supertrendIndicator(
        candles,
        params.stPeriod.value,
        params.stMult.value,
      );
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes: htf } = ctx;
      if (index < 2) return null;

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

      // ── Daily ADX (completed bar only — anti-lookahead) ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 28) return null;

      const dAdx = dailyAdxCache ?? adxIndicator(dCandles, 14);
      const adxVal = findDailyValue(currentCandle.t, dCandles, dAdx.adx);
      if (isNaN(adxVal)) return null;

      // ── Daily ATR for initial stop (completed bar only) ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const adxThresh = params.adxThreshold.value;
      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("stDir", currDir);
      ctx.indicator("stValue", st.supertrend[index]);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);

      // ── LONG: SuperTrend flips to uptrend + ADX confirms trend ──
      const longFlip = ctx.track(
        "L:st_flip_bull",
        prevDir === -1 && currDir === 1,
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
          comment: "SuperTrend bullish flip (ADX trend confirmed)",
        };
      }

      // ── SHORT: SuperTrend flips to downtrend + ADX confirms trend ──
      const shortFlip = ctx.track(
        "S:st_flip_bear",
        prevDir === 1 && currDir === -1,
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
          comment: "SuperTrend bearish flip (ADX trend confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB rule 6)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // No trailing exit — timeout is the only managed exit.
      // Hard SL is handled by the engine (not in shouldExit).
      return null;
    },

    getExitLevel(_ctx: StrategyContext): number | null {
      // No trailing exit mechanism — timeout is time-based, not price-based.
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
