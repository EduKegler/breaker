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
import {
  chandelier as chandelierIndicator,
  type ChandelierResult,
} from "../../../indicators/chandelier.js";

const MS_1D = 86_400_000;

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed Chandelier lookback period (standard 22, Le Beau default). Not optimizable to stay within 6-var cap. */
const CHANDELIER_PERIOD = 22;

interface LongSupertrendAdxHighChandelierParams {
  stPeriod: StrategyParam;
  stMult: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  chandelierMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: LongSupertrendAdxHighChandelierParams = {
  stPeriod: {
    value: 10,
    min: 7,
    max: 14,
    step: 1,
    optimizable: true,
    description: "SuperTrend ATR lookback period on 4H",
  },
  stMult: {
    value: 2.0,
    min: 1.5,
    max: 3.5,
    step: 0.5,
    optimizable: true,
    description:
      "SuperTrend ATR multiplier on 4H (lower = more sensitive flips)",
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
  chandelierMult: {
    value: 3.0,
    min: 2.0,
    max: 5.0,
    step: 0.5,
    optimizable: true,
    description: "Chandelier Exit ATR multiplier on 4H for trailing stop",
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

export function createLongSupertrendAdxHighChandelier(
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
    name: "BTC 4H Trend Following — Long SuperTrend ADX Chandelier",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 100, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      stCache = supertrendIndicator(
        candles,
        params.stPeriod.value,
        params.stMult.value,
      );
      chandelierCache = chandelierIndicator(
        candles,
        CHANDELIER_PERIOD,
        params.chandelierMult.value,
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

      // ── SuperTrend on source (4H) — no anti-lookahead needed for source TF ──
      const st =
        stCache ??
        supertrendIndicator(
          candles.slice(0, index + 1),
          params.stPeriod.value,
          params.stMult.value,
        );

      const currDir = st.direction[index];
      const prevDir = st.direction[index - 1];

      // Skip if SuperTrend not yet initialized (NaN during warmup)
      if (isNaN(currDir) || isNaN(prevDir)) return null;

      // ── Daily ADX (completed bar only — anti-lookahead) ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 28) return null;

      const dAdx = dailyAdxCache ?? adxIndicator(dCandles, 14);
      const adxVal = findDailyValue(currentCandle.t, dCandles, dAdx.adx);
      if (isNaN(adxVal)) return null;

      // ── Daily ATR for initial stop (completed bar only — anti-lookahead) ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const adxThresh = params.adxThreshold.value;
      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("stDirection", currDir);
      ctx.indicator("stLine", st.supertrend[index]);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);

      // ── LONG ONLY: SuperTrend flip bullish (-1 → 1) + ADX confirms trend ──
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
          comment: "SuperTrend flip bullish (ADX trend confirmed)",
        };
      }

      return null;
    },

    shouldExit(
      ctx: StrategyContext,
    ): { exit: boolean; comment: string } | null {
      const {
        candles,
        index,
        currentCandle,
        positionDirection,
        positionEntryBarIndex,
      } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;
      if (positionDirection !== "long") return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB §6)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Trailing exit blocked during minimum hold (KB §9)
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // Chandelier Exit: long position exits when price drops below longExit level
      const chand =
        chandelierCache ??
        chandelierIndicator(
          candles.slice(0, index + 1),
          CHANDELIER_PERIOD,
          params.chandelierMult.value,
        );
      const exitLevel = chand.longExit[index];
      if (isNaN(exitLevel)) return null;

      if (currentCandle.c < exitLevel) {
        return { exit: true, comment: "Chandelier exit (long)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;
      if (positionDirection !== "long") return null;

      // No trailing level during min hold period
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const chand =
        chandelierCache ??
        chandelierIndicator(
          candles.slice(0, index + 1),
          CHANDELIER_PERIOD,
          params.chandelierMult.value,
        );
      const exitLevel = chand.longExit[index];
      if (isNaN(exitLevel)) return null;

      return exitLevel;
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
