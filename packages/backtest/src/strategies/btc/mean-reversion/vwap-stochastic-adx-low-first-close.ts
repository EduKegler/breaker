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
const SHORT_TIMEOUT_RATIO = 0.67; // timeout_short = timeout_long * 0.67 (Rule 7 asymmetry)
const VIRTUAL_STOP_ATR_MULT = 4.0; // Wide virtual stop for position sizing (Rule 4)

interface VwapStochasticAdxLowFirstCloseParams {
  vwapBandMult: StrategyParam;
  stochPeriod: StrategyParam;
  stochThreshLong: StrategyParam;
  stochThreshShort: StrategyParam;
  adxThreshold: StrategyParam;
  timeoutBarsLong: StrategyParam;
}

const DEFAULT_PARAMS: VwapStochasticAdxLowFirstCloseParams = {
  vwapBandMult: {
    value: 1.5, min: 0.5, max: 3.0, step: 0.25, optimizable: true,
    description: "VWAP band multiplier K — distance from VWAP to upper/lower bands in std devs",
  },
  stochPeriod: {
    value: 10, min: 5, max: 14, step: 1, optimizable: true,
    description: "Stochastic %K lookback period",
  },
  stochThreshLong: {
    value: 25, min: 10, max: 35, step: 5, optimizable: true,
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
    description: "Forced exit after N bars for longs (shorts = N * 0.67) — backup to first-close",
  },
};

export function createVwapStochasticAdxLowFirstClose(
  paramOverrides?: Partial<Record<keyof VwapStochasticAdxLowFirstCloseParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof VwapStochasticAdxLowFirstCloseParams];
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
    name: "BTC 15m Mean Reversion — VWAP Stochastic ADX-Low First-Close",
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
      if (index < stochPeriod + STOCH_D_PERIOD) return null; // warmup
      if (ctx.positionDirection) return null;

      // Use previous bar's indicator values to avoid look-ahead
      const curr = index - 1;

      const vwapUpper = vwapCache ? vwapCache.upper[curr] : NaN;
      const vwapLower = vwapCache ? vwapCache.lower[curr] : NaN;
      const vwapMid = vwapCache ? vwapCache.vwap[curr] : NaN;
      const stochK = stochCache ? stochCache.k[curr] : NaN;
      const stochD = stochCache ? stochCache.d[curr] : NaN;

      if (isNaN(vwapUpper) || isNaN(vwapLower) || isNaN(vwapMid)) return null;
      if (isNaN(stochK) || isNaN(stochD)) return null;

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

      // --- LONG: close at/below VWAP lower band + Stochastic oversold zone + ADX low ---
      const longBand = ctx.track("L:below_vwap_lower", close <= vwapLower, close, vwapLower);
      const longStoch = ctx.track("L:stoch_oversold", stochK < params.stochThreshLong.value, stochK, params.stochThreshLong.value);
      const longRegime = ctx.track("L:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (longBand && longStoch && longRegime) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - virtualStopDist,
          takeProfits: [],
          comment: "VWAP lower + Stoch oversold (MR long)",
        };
      }

      // --- SHORT: close at/above VWAP upper band + Stochastic overbought zone + ADX low ---
      const shortBand = ctx.track("S:above_vwap_upper", close >= vwapUpper, close, vwapUpper);
      const shortStoch = ctx.track("S:stoch_overbought", stochK > params.stochThreshShort.value, stochK, params.stochThreshShort.value);
      const shortRegime = ctx.track("S:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (shortBand && shortStoch && shortRegime) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + virtualStopDist,
          takeProfits: [],
          comment: "VWAP upper + Stoch overbought (MR short)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      const timeoutLong = Math.round(params.timeoutBarsLong.value);
      const timeoutShort = Math.round(timeoutLong * SHORT_TIMEOUT_RATIO);

      // Timeout exit — checked first per rules (backup to first-close)
      if (ctx.positionDirection === "long" && barsInTrade >= timeoutLong) {
        return { exit: true, comment: "Timeout (long)" };
      }
      if (ctx.positionDirection === "short" && barsInTrade >= timeoutShort) {
        return { exit: true, comment: "Timeout (short)" };
      }

      // First-close exit: exit on first bar that closes in the direction of reversion
      // Must be at least 1 bar in trade (skip entry bar)
      if (barsInTrade >= 1) {
        const { currentCandle } = ctx;
        const bullishClose = currentCandle.c > currentCandle.o; // close > open = price reverting up
        const bearishClose = currentCandle.c < currentCandle.o; // close < open = price reverting down

        if (ctx.positionDirection === "long" && bullishClose) {
          return { exit: true, comment: "First bullish close (MR reversion)" };
        }
        if (ctx.positionDirection === "short" && bearishClose) {
          return { exit: true, comment: "First bearish close (MR reversion)" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      // First-close exit is bar-based, no fixed price level
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
