import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { stochastic as computeStochastic, type StochasticResult } from "../../../indicators/stochastic.js";
import { adx as computeAdx, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;

// Fixed constants (not optimizable)
const ADX_PERIOD = 14; // Wilder default
const STOCH_D_PERIOD = 3; // %D smoothing (SMA of %K)
const SHORT_TIMEOUT_RATIO = 0.67; // timeout_short = timeout_long × 0.67 (Rule 7 asymmetry)
const VIRTUAL_STOP_ATR_MULT = 5.0; // Wide catastrophic stop for position sizing (Rule 4)

interface PctBandsStochasticAdxLowTimeoutParams {
  maPeriod: StrategyParam;
  bandPct: StrategyParam;
  stochPeriod: StrategyParam;
  stochThreshLong: StrategyParam;
  adxThreshold: StrategyParam;
  timeoutBarsLong: StrategyParam;
}

const DEFAULT_PARAMS: PctBandsStochasticAdxLowTimeoutParams = {
  maPeriod: {
    value: 20, min: 10, max: 40, step: 2, optimizable: true,
    description: "SMA period for percentage bands midline",
  },
  bandPct: {
    value: 1.0, min: 0.5, max: 3.0, step: 0.25, optimizable: true,
    description: "Percentage distance from SMA to upper/lower band (e.g. 1.0 = ±1%)",
  },
  stochPeriod: {
    value: 10, min: 5, max: 14, step: 1, optimizable: true,
    description: "Stochastic %K lookback period",
  },
  stochThreshLong: {
    value: 25, min: 10, max: 35, step: 5, optimizable: true,
    description: "Stochastic %K must be below this for long entry (short = 100 - this)",
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

export function createPctBandsStochasticAdxLowTimeout(
  paramOverrides?: Partial<Record<keyof PctBandsStochasticAdxLowTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof PctBandsStochasticAdxLowTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let smaCache: number[] | null = null;
  let stochCache: StochasticResult | null = null;
  let htfAdxCache1h: AdxResult | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;

  /** Anti-repaint: find last fully-closed 1H candle value */
  function findHtf1hValue(currentT: number, htfRef: Candle[], values: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(values[j])) {
        return values[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Mean Reversion — Pct Bands Stochastic ADX-Low Timeout",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 50, "1h": 120 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const period = Math.round(params.maPeriod.value);
      smaCache = sma(candles.map((c) => c.c), period);
      stochCache = computeStochastic(candles, Math.round(params.stochPeriod.value), STOCH_D_PERIOD);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAdxCache1h = computeAdx(htf1hCandles, ADX_PERIOD);
        htfAtrCache1h = atr(htf1hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, higherTimeframes } = ctx;
      const period = Math.round(params.maPeriod.value);
      const stochPeriod = Math.round(params.stochPeriod.value);
      if (index < Math.max(period, stochPeriod + STOCH_D_PERIOD) + 1) return null;
      if (ctx.positionDirection) return null;

      // Previous-bar indicators (avoid look-ahead bias)
      const prev = index - 1;

      const smaVal = smaCache ? smaCache[prev] : NaN;
      const stochK = stochCache ? stochCache.k[prev] : NaN;
      if (isNaN(smaVal) || isNaN(stochK)) return null;

      // Percentage bands from SMA
      const bandPctFrac = params.bandPct.value / 100;
      const upperBand = smaVal * (1 + bandPctFrac);
      const lowerBand = smaVal * (1 - bandPctFrac);

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
      const stochThreshLong = params.stochThreshLong.value;
      const stochThreshShort = 100 - stochThreshLong; // Derived: saves 1 var
      const virtualStopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;

      // Diagnostics
      ctx.indicator("sma", smaVal);
      ctx.indicator("upperBand", upperBand);
      ctx.indicator("lowerBand", lowerBand);
      ctx.indicator("stochK", stochK);
      ctx.indicator("adx1h", adxVal);
      ctx.indicator("atr1h", atr1hVal);

      // --- LONG: close at/below lower band + Stochastic oversold zone + ADX low (ranging) ---
      const longBand = ctx.track("L:below_lower_band", close <= lowerBand, close, lowerBand);
      const longStoch = ctx.track("L:stoch_oversold", stochK < stochThreshLong, stochK, stochThreshLong);
      const longRegime = ctx.track("L:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (longBand && longStoch && longRegime) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - virtualStopDist,
          takeProfits: [],
          comment: "Pct band lower + Stoch oversold + ADX low (MR long)",
        };
      }

      // --- SHORT: close at/above upper band + Stochastic overbought zone + ADX low (ranging) ---
      const shortBand = ctx.track("S:above_upper_band", close >= upperBand, close, upperBand);
      const shortStoch = ctx.track("S:stoch_overbought", stochK > stochThreshShort, stochK, stochThreshShort);
      const shortRegime = ctx.track("S:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (shortBand && shortStoch && shortRegime) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + virtualStopDist,
          takeProfits: [],
          comment: "Pct band upper + Stoch overbought + ADX low (MR short)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      const timeoutLong = Math.round(params.timeoutBarsLong.value);
      const timeoutShort = Math.round(timeoutLong * SHORT_TIMEOUT_RATIO);

      // Timeout exit (mandatory — asymmetric: shorts have shorter timeout) — checked first per rules
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
