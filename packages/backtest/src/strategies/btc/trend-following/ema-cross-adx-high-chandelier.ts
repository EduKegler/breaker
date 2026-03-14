import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import {
  chandelier as chandelierIndicator,
  type ChandelierResult,
} from "../../../indicators/chandelier.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";
import { ema } from "../../../indicators/ema.js";

const MS_1D = 86_400_000;

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed Chandelier lookback period (standard 22). Not optimizable to stay within 6-var cap. */
const CHANDELIER_PERIOD = 22;

interface EmaCrossAdxHighChandelierParams {
  emaFast: StrategyParam;
  emaSlow: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  chandelierMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: EmaCrossAdxHighChandelierParams = {
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
  chandelierMult: {
    value: 3.0,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Chandelier Exit ATR multiplier on 4H (KB floor: 3.0)",
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

export function createEmaCrossAdxHighChandelier(
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
    name: "BTC 4H Trend Following — EMA Cross ADX Chandelier",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 100, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes = candles.map((c) => c.c);
      fastEmaCache = ema(closes, params.emaFast.value);
      slowEmaCache = ema(closes, params.emaSlow.value);
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

      // ── EMA Cross on source (4H) ──
      const closes = candles.slice(0, index + 1).map((c) => c.c);
      const fastVals =
        fastEmaCache ?? ema(closes, params.emaFast.value);
      const slowVals =
        slowEmaCache ?? ema(closes, params.emaSlow.value);

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

      // ── LONG: Fast EMA crosses above Slow EMA + ADX confirms trend ──
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

      // ── SHORT: Fast EMA crosses below Slow EMA + ADX confirms trend ──
      const shortCross = ctx.track(
        "S:ema_cross_bear",
        prevFast >= prevSlow && currFast < currSlow,
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
          comment: "EMA cross bearish (ADX trend confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const {
        candles,
        index,
        currentCandle,
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

      // Chandelier Exit trailing stop
      const chand =
        chandelierCache ??
        chandelierIndicator(
          candles.slice(0, index + 1),
          CHANDELIER_PERIOD,
          params.chandelierMult.value,
        );

      if (positionDirection === "long") {
        const exitLevel = chand.longExit[index];
        if (!isNaN(exitLevel) && currentCandle.c < exitLevel) {
          return { exit: true, comment: "Chandelier exit (long)" };
        }
      }

      if (positionDirection === "short") {
        const exitLevel = chand.shortExit[index];
        if (!isNaN(exitLevel) && currentCandle.c > exitLevel) {
          return { exit: true, comment: "Chandelier exit (short)" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

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

      if (positionDirection === "long") {
        const level = chand.longExit[index];
        return isNaN(level) ? null : level;
      }
      if (positionDirection === "short") {
        const level = chand.shortExit[index];
        return isNaN(level) ? null : level;
      }

      return null;
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
