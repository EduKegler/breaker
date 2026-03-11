import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma as computeSma } from "../../../indicators/sma.js";
import { rsi as computeRsi } from "../../../indicators/rsi.js";
import { adx as computeAdx, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;

// Fixed constants (not optimizable)
const ADX_PERIOD = 14; // Wilder default
const SHORT_TIMEOUT_RATIO = 0.67; // timeout_short = timeout_long * 0.67 (Rule 7 asymmetry)
const VIRTUAL_STOP_ATR_MULT = 4.0; // Wide virtual stop for position sizing (Rule 4)

interface PctBandsRsi35AdxLowTimeoutParams {
  maPeriod: StrategyParam;
  bandPct: StrategyParam;
  rsiPeriod: StrategyParam;
  rsiThreshLong: StrategyParam;
  adxThreshold: StrategyParam;
  timeoutBarsLong: StrategyParam;
}

const DEFAULT_PARAMS: PctBandsRsi35AdxLowTimeoutParams = {
  maPeriod: {
    value: 20, min: 10, max: 40, step: 2, optimizable: true,
    description: "SMA period for percentage bands midline",
  },
  bandPct: {
    value: 2.0, min: 1.0, max: 4.0, step: 0.25, optimizable: true,
    description: "Percentage distance from SMA to upper/lower band (2.0 = ±2%)",
  },
  rsiPeriod: {
    value: 4, min: 3, max: 5, step: 1, optimizable: true,
    description: "RSI lookback period (3-5 range per rsi35 spec)",
  },
  rsiThreshLong: {
    value: 20, min: 10, max: 30, step: 5, optimizable: true,
    description: "RSI must be below this for long entry (short threshold = 100 - this)",
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

export function createPctBandsRsi35AdxLowTimeout(
  paramOverrides?: Partial<Record<keyof PctBandsRsi35AdxLowTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof PctBandsRsi35AdxLowTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let smaCache: number[] = [];
  let rsiCache: number[] = [];
  let htfAdxCache1h: AdxResult | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;

  /** Anti-repaint: find last fully-closed 1H candle value */
  function findHtf1hValue(currentT: number, htfRef: Candle[], values: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT) {
        return isNaN(values[j]) ? NaN : values[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Mean Reversion — Pct-Bands RSI35 ADX-Low Timeout",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 50, "1h": 120 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes = candles.map(c => c.c);
      smaCache = computeSma(closes, Math.round(params.maPeriod.value));
      rsiCache = computeRsi(closes, Math.round(params.rsiPeriod.value));

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAdxCache1h = computeAdx(htf1hCandles, ADX_PERIOD);
        htfAtrCache1h = atr(htf1hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, higherTimeframes } = ctx;
      const maPeriod = Math.round(params.maPeriod.value);
      const rsiPeriod = Math.round(params.rsiPeriod.value);
      if (index < maPeriod + rsiPeriod) return null; // warmup
      if (ctx.positionDirection) return null;

      const close = currentCandle.c;
      const smaVal = smaCache[index];
      const rsiVal = rsiCache[index];

      if (isNaN(smaVal) || isNaN(rsiVal)) return null;

      // Percentage bands: SMA ± bandPct%
      const bandMult = params.bandPct.value / 100;
      const upperBand = smaVal * (1 + bandMult);
      const lowerBand = smaVal * (1 - bandMult);

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

      const virtualStopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;

      // Diagnostics
      ctx.indicator("sma", smaVal);
      ctx.indicator("upperBand", upperBand);
      ctx.indicator("lowerBand", lowerBand);
      ctx.indicator("rsi", rsiVal);
      ctx.indicator("adx1h", adxVal);
      ctx.indicator("atr1h", atr1hVal);

      const rsiThreshLong = params.rsiThreshLong.value;
      const rsiThreshShort = 100 - rsiThreshLong; // Rule 7: symmetric derivation

      // --- LONG: close below lower pct-band + RSI oversold + ADX low ---
      const longBand = ctx.track("L:below_lower_band", close <= lowerBand, close, lowerBand);
      const longRsi = ctx.track("L:rsi_oversold", rsiVal < rsiThreshLong, rsiVal, rsiThreshLong);
      const longRegime = ctx.track("L:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (longBand && longRsi && longRegime) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - virtualStopDist,
          takeProfits: [],
          comment: "Pct-band lower + RSI oversold (MR long)",
        };
      }

      // --- SHORT: close above upper pct-band + RSI overbought + ADX low ---
      const shortBand = ctx.track("S:above_upper_band", close >= upperBand, close, upperBand);
      const shortRsi = ctx.track("S:rsi_overbought", rsiVal > rsiThreshShort, rsiVal, rsiThreshShort);
      const shortRegime = ctx.track("S:adx_low", adxVal < params.adxThreshold.value, adxVal, params.adxThreshold.value);

      if (shortBand && shortRsi && shortRegime) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + virtualStopDist,
          takeProfits: [],
          comment: "Pct-band upper + RSI overbought (MR short)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      const timeoutLong = Math.round(params.timeoutBarsLong.value);
      const timeoutShort = Math.round(timeoutLong * SHORT_TIMEOUT_RATIO);

      // Timeout exit — checked first per rules
      if (ctx.positionDirection === "long" && barsInTrade >= timeoutLong) {
        return { exit: true, comment: "Timeout (long)" };
      }
      if (ctx.positionDirection === "short" && barsInTrade >= timeoutShort) {
        return { exit: true, comment: "Timeout (short)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      // Timeout exit is bar-based, no fixed price level
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
