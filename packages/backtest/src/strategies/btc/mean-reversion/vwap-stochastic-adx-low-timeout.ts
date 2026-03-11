import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { vwap as computeVwap, type VwapResult } from "../../../indicators/vwap.js";
import { stochastic as computeStochastic, type StochasticResult } from "../../../indicators/stochastic.js";
import { adx as computeAdx, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;

// Fixed constants (not optimizable)
const ADX_PERIOD = 14; // Wilder default
const STOCH_D_PERIOD = 3; // %D smoothing (SMA of %K)
const SHORT_TIMEOUT_RATIO = 0.67; // timeout_short = timeout_long × 0.67 (Rule 7 asymmetry)
const VIRTUAL_STOP_ATR_MULT = 5.0; // Wide catastrophic stop for position sizing (Rule 4)

interface VwapStochasticAdxLowTimeoutParams {
  vwapBandMult: StrategyParam;
  stochPeriod: StrategyParam;
  stochThreshLong: StrategyParam;
  stochThreshShort: StrategyParam;
  adxThreshold: StrategyParam;
  timeoutBarsLong: StrategyParam;
}

const DEFAULT_PARAMS: VwapStochasticAdxLowTimeoutParams = {
  vwapBandMult: {
    value: 2.0, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "VWAP band multiplier K — distance from VWAP to upper/lower bands in std devs",
  },
  stochPeriod: {
    value: 10, min: 5, max: 14, step: 1, optimizable: true,
    description: "Stochastic %K lookback period",
  },
  stochThreshLong: {
    value: 20, min: 10, max: 35, step: 5, optimizable: true,
    description: "Stochastic %K must be below this for long entry (oversold zone)",
  },
  stochThreshShort: {
    value: 80, min: 65, max: 90, step: 5, optimizable: true,
    description: "Stochastic %K must be above this for short entry (overbought zone)",
  },
  adxThreshold: {
    value: 25, min: 15, max: 35, step: 5, optimizable: true,
    description: "ADX(14) on 1H must be below this — ranging regime gate",
  },
  timeoutBarsLong: {
    value: 24, min: 12, max: 48, step: 4, optimizable: true,
    description: "Forced exit after N bars for longs (shorts = N × 0.67)",
  },
};

export function createVwapStochasticAdxLowTimeout(
  paramOverrides?: Partial<Record<keyof VwapStochasticAdxLowTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof VwapStochasticAdxLowTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let vwapCache: VwapResult | null = null;
  let stochCache: StochasticResult | null = null;
  let htfAdxCache1h: AdxResult | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;

  /** Anti-repaint: find last fully-closed 1H candle index */
  function findHtf1hIndex(currentT: number, htfRef: Candle[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT) {
        return j;
      }
    }
    return -1;
  }

  /** Anti-repaint: find last fully-closed 1H candle value */
  function findHtf1hValue(currentT: number, htfRef: Candle[], values: number[]): number {
    const idx = findHtf1hIndex(currentT, htfRef);
    if (idx < 0 || isNaN(values[idx])) return NaN;
    return values[idx];
  }

  return {
    name: "BTC 15m Mean Reversion — VWAP Stochastic ADX-Low Timeout",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 50, "1h": 120 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      vwapCache = computeVwap(candles, params.vwapBandMult.value);
      stochCache = computeStochastic(candles, Math.round(params.stochPeriod.value), STOCH_D_PERIOD);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAdxCache1h = computeAdx(htf1hCandles, ADX_PERIOD);
        htfAtrCache1h = atr(htf1hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, higherTimeframes } = ctx;
      const stochPeriod = Math.round(params.stochPeriod.value);
      if (index < stochPeriod + STOCH_D_PERIOD + 1) return null; // warmup: need prev bar stoch too
      if (ctx.positionDirection) return null;

      // Current and previous bar indicators (previous bar for crossover detection)
      const curr = index - 1; // use prev-bar values to avoid look-ahead
      const prev = index - 2;

      const vwapUpper = vwapCache ? vwapCache.upper[curr] : NaN;
      const vwapLower = vwapCache ? vwapCache.lower[curr] : NaN;
      const vwapMid = vwapCache ? vwapCache.vwap[curr] : NaN;
      const stochK = stochCache ? stochCache.k[curr] : NaN;
      const stochD = stochCache ? stochCache.d[curr] : NaN;
      const prevStochK = stochCache ? stochCache.k[prev] : NaN;
      const prevStochD = stochCache ? stochCache.d[prev] : NaN;

      if (isNaN(vwapUpper) || isNaN(vwapLower) || isNaN(vwapMid)) return null;
      if (isNaN(stochK) || isNaN(stochD) || isNaN(prevStochK) || isNaN(prevStochD)) return null;

      // HTF: 1H ADX regime gate (anti-repaint — last closed 1H candle)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 40) return null;
      const adxResult = htfAdxCache1h ?? computeAdx(htf1hRef, ADX_PERIOD);
      const adxVal = findHtf1hValue(currentCandle.t, htf1hRef, adxResult.adx);
      if (isNaN(adxVal)) return null;

      // HTF: 1H ATR for virtual stop (position sizing)
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findHtf1hValue(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      const close = currentCandle.c;
      const virtualStopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;

      // Diagnostics
      ctx.indicator("vwapUpper", vwapUpper);
      ctx.indicator("vwapLower", vwapLower);
      ctx.indicator("vwapMid", vwapMid);
      ctx.indicator("stochK", stochK);
      ctx.indicator("stochD", stochD);
      ctx.indicator("adx1h", adxVal);
      ctx.indicator("atr1h", atr1hVal);

      // Stochastic crossover detection (prev bar → curr bar)
      const bullishCrossover = prevStochK <= prevStochD && stochK > stochD; // %K crosses above %D
      const bearishCrossover = prevStochK >= prevStochD && stochK < stochD; // %K crosses below %D

      // --- LONG: close at/below VWAP lower band + Stochastic oversold crossover + ADX low (ranging) ---
      const longBand = ctx.track("L:below_vwap_lower", close <= vwapLower, close, vwapLower);
      const longStochZone = ctx.track("L:stoch_oversold", stochK < params.stochThreshLong.value, stochK, params.stochThreshLong.value);
      const longCrossover = ctx.track("L:stoch_bullish_cross", bullishCrossover);
      const longRegime = ctx.track("L:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (longBand && longStochZone && longCrossover && longRegime) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - virtualStopDist,
          takeProfits: [],
          comment: "VWAP lower + Stoch oversold crossover (MR long)",
        };
      }

      // --- SHORT: close at/above VWAP upper band + Stochastic overbought crossover + ADX low (ranging) ---
      const shortBand = ctx.track("S:above_vwap_upper", close >= vwapUpper, close, vwapUpper);
      const shortStochZone = ctx.track("S:stoch_overbought", stochK > params.stochThreshShort.value, stochK, params.stochThreshShort.value);
      const shortCrossover = ctx.track("S:stoch_bearish_cross", bearishCrossover);
      const shortRegime = ctx.track("S:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (shortBand && shortStochZone && shortCrossover && shortRegime) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + virtualStopDist,
          takeProfits: [],
          comment: "VWAP upper + Stoch overbought crossover (MR short)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      const timeoutLong = Math.round(params.timeoutBarsLong.value);
      const timeoutShort = Math.round(timeoutLong * SHORT_TIMEOUT_RATIO);

      // Timeout exit (asymmetric: shorts have shorter timeout) — checked first per rules
      if (ctx.positionDirection === "long" && barsInTrade >= timeoutLong) {
        return { exit: true, comment: "Timeout (long)" };
      }
      if (ctx.positionDirection === "short" && barsInTrade >= timeoutShort) {
        return { exit: true, comment: "Timeout (short)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      // Timeout-only exit — no price-based exit level
      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findHtf1hValue(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;
      const close = currentCandle.c;

      if (direction === "long") {
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
