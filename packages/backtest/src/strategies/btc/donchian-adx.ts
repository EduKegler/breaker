import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../types/strategy.js";
import type { Candle } from "../../types/candle.js";
import { donchian } from "../../indicators/donchian.js";
import { adx } from "../../indicators/adx.js";
import { ema } from "../../indicators/ema.js";
import { atr } from "../../indicators/atr.js";
import { sma } from "../../indicators/sma.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

const TP_R_MULT = 2;  // partial TP at 2R (baked)
const TP_PCT = 0.50;   // close 50% at TP (fraction 0-1)

export interface DonchianAdxParams {
  dcSlow: StrategyParam;
  dcFast: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  volMult: StrategyParam;
  htfEmaPeriod: StrategyParam;
  timeoutBars: StrategyParam;
  maxTradesDay: StrategyParam;
}

const DEFAULT_PARAMS: DonchianAdxParams = {
  dcSlow: { value: 50, min: 30, max: 60, step: 5, optimizable: true, description: "Slow Donchian period for entry" },
  dcFast: { value: 20, min: 10, max: 25, step: 5, optimizable: true, description: "Fast Donchian period for trailing exit" },
  adxThreshold: { value: 25, min: 20, max: 35, step: 5, optimizable: true, description: "ADX below this = consolidation" },
  atrStopMult: { value: 3, min: 3, max: 5, step: 0.5, optimizable: true, description: "ATR multiplier for safety stop (KB §1.6: min 3.0 for breakout)" },
  volMult: { value: 1.5, min: 1, max: 3, step: 0.5, optimizable: true, description: "Volume spike multiplier vs SMA(vol, 20) — KB §3.1 rule 3" },
  htfEmaPeriod: { value: 50, min: 20, max: 200, step: 20, optimizable: true, description: "4H EMA period for regime filter" },
  timeoutBars: { value: 24, min: 24, max: 96, step: 8, optimizable: true, description: "Bars before timeout exit (KB range: 24–96)" },
  maxTradesDay: { value: 3, min: 2, max: 5, step: 1, optimizable: false, description: "Max trades per day" },
};

/**
 * Build anti-repaint mapping from source candle indices to last completed HTF bar values.
 * For each source candle, finds the most recent HTF bar that has completed (bar.t + htfMs <= source.t)
 * and has a valid (non-NaN) indicator value.
 */
function mapHtfToSource(
  sourceCandles: Candle[],
  htfCandles: Candle[],
  htfValues: number[],
  htfMs: number,
): number[] {
  const result = new Array<number>(sourceCandles.length).fill(NaN);
  let lastValidIdx = -1;
  let j = 0;

  for (let i = 0; i < sourceCandles.length; i++) {
    const t = sourceCandles[i].t;
    while (j < htfCandles.length && htfCandles[j].t + htfMs <= t) {
      if (!isNaN(htfValues[j])) lastValidIdx = j;
      j++;
    }
    if (lastValidIdx >= 0) {
      result[i] = htfValues[lastValidIdx];
    }
  }

  return result;
}

/**
 * Donchian ADX breakout strategy — 4H EMA regime + volume confirmation + partial TP.
 *
 * Entry: Donchian breakout + low ADX (consolidation) + 4H EMA regime filter + volume spike.
 * Exit: Partial TP at 2R (50%), Donchian fast trail (remaining), timeout fallback.
 *
 * Indicators are pre-computed in init() for O(n) total instead of O(n²) per-bar recomputation.
 */
export function createDonchianAdx(
  paramOverrides?: Partial<Record<keyof DonchianAdxParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof DonchianAdxParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Pre-computed indicator arrays (populated in init())
  let _dcSlowUpper: number[] = [];
  let _dcSlowLower: number[] = [];
  let _dcFastUpper: number[] = [];
  let _dcFastLower: number[] = [];
  let _adxArr: number[] = [];
  let _volSma20: number[] = [];
  let _atr1h: number[] = [];
  let _ema4h: number[] = [];

  return {
    name: "BTC 15m Breakout — Donchian ADX",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 60, "1h": 15, "4h": 210 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>) {
      // Source timeframe indicators
      const dcSlow = donchian(candles, params.dcSlow.value);
      _dcSlowUpper = dcSlow.upper;
      _dcSlowLower = dcSlow.lower;

      const dcFast = donchian(candles, params.dcFast.value);
      _dcFastUpper = dcFast.upper;
      _dcFastLower = dcFast.lower;

      const adxResult = adx(candles, 14);
      _adxArr = adxResult.adx;

      const volumes = candles.map((c: Candle) => c.v);
      _volSma20 = sma(volumes, 20);

      // 1H ATR mapped to source indices (anti-repaint)
      const htf1h = higherTimeframes["1h"];
      if (htf1h && htf1h.length >= 15) {
        const htfAtr = atr(htf1h, 14);
        _atr1h = mapHtfToSource(candles, htf1h, htfAtr, MS_1H);
      } else {
        _atr1h = new Array(candles.length).fill(NaN);
      }

      // 4H EMA mapped to source indices (anti-repaint)
      const h4 = higherTimeframes["4h"];
      if (h4 && h4.length >= params.htfEmaPeriod.value + 1) {
        const h4Closes = h4.map((c: Candle) => c.c);
        const ema4hArr = ema(h4Closes, params.htfEmaPeriod.value);
        _ema4h = mapHtfToSource(candles, h4, ema4hArr, MS_4H);
      } else {
        _ema4h = new Array(candles.length).fill(NaN);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle } = ctx;
      if (index < params.dcSlow.value + 1) return null;

      const prevSlowUpper = _dcSlowUpper[index - 1];
      const prevSlowLower = _dcSlowLower[index - 1];
      if (isNaN(prevSlowUpper) || isNaN(prevSlowLower)) return null;
      ctx.indicator("dcSlowUpper", prevSlowUpper);
      ctx.indicator("dcSlowLower", prevSlowLower);

      const adxVal = _adxArr[index];
      if (isNaN(adxVal)) return null;
      ctx.indicator("adx", adxVal);

      const currentVolSma = _volSma20[index];
      const currentVol = currentCandle.v;
      if (isNaN(currentVolSma)) return null;
      ctx.indicator("volume", currentVol);
      ctx.indicator("volSma20", currentVolSma);

      const atr1h = _atr1h[index];
      if (isNaN(atr1h)) return null;
      ctx.indicator("atr1h", atr1h);

      const htfEma = _ema4h[index];
      if (isNaN(htfEma)) return null;
      ctx.indicator("ema4h", htfEma);

      const stopDist = atr1h * params.atrStopMult.value;
      const volThreshold = params.volMult.value * currentVolSma;

      // LONG signal: DC breakout + low ADX + bullish 4H regime + volume spike
      const longBreakout = currentCandle.c > prevSlowUpper;
      const longAdx = adxVal < params.adxThreshold.value;
      const longRegime = currentCandle.c > htfEma;
      const longVol = currentVol > volThreshold;

      if (
        ctx.track("L:dcBreakout", longBreakout, currentCandle.c, prevSlowUpper) &&
        ctx.track("L:adxLow", longAdx, adxVal, params.adxThreshold.value) &&
        ctx.track("L:regime", longRegime, currentCandle.c, htfEma) &&
        ctx.track("L:volSpike", longVol, currentVol, volThreshold)
      ) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: currentCandle.c - stopDist,
          takeProfits: [{ price: currentCandle.c + TP_R_MULT * stopDist, pctOfPosition: TP_PCT }],
          comment: "DC breakout long",
        };
      }

      // SHORT signal: DC breakout + low ADX + bearish 4H regime + volume spike
      const shortBreakout = currentCandle.c < prevSlowLower;
      const shortAdx = adxVal < params.adxThreshold.value;
      const shortRegime = currentCandle.c < htfEma;
      const shortVol = currentVol > volThreshold;

      if (
        ctx.track("S:dcBreakout", shortBreakout, currentCandle.c, prevSlowLower) &&
        ctx.track("S:adxLow", shortAdx, adxVal, params.adxThreshold.value) &&
        ctx.track("S:regime", shortRegime, currentCandle.c, htfEma) &&
        ctx.track("S:volSpike", shortVol, currentVol, volThreshold)
      ) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: currentCandle.c + stopDist,
          takeProfits: [{ price: currentCandle.c - TP_R_MULT * stopDist, pctOfPosition: TP_PCT }],
          comment: "DC breakout short",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || index < params.dcFast.value + 1) return null;

      // Timeout exit (MANDATORY first check)
      if (positionEntryBarIndex !== null) {
        const barsInTrade = index - positionEntryBarIndex;
        if (barsInTrade >= params.timeoutBars.value) {
          return { exit: true, comment: "timeout" };
        }
      }

      // Donchian fast trail exit on remaining position
      const prevFastUpper = _dcFastUpper[index - 1];
      const prevFastLower = _dcFastLower[index - 1];
      if (isNaN(prevFastUpper) || isNaN(prevFastLower)) return null;

      const currentCandle = ctx.candles[index];

      if (positionDirection === "long" && currentCandle.c < prevFastLower) {
        return { exit: true, comment: "DC Trail" };
      }

      if (positionDirection === "short" && currentCandle.c > prevFastUpper) {
        return { exit: true, comment: "DC Trail" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection } = ctx;
      if (!positionDirection || index < params.dcFast.value + 1) return null;

      const prevFastUpper = _dcFastUpper[index - 1];
      const prevFastLower = _dcFastLower[index - 1];
      if (isNaN(prevFastUpper) || isNaN(prevFastLower)) return null;

      return positionDirection === "long" ? prevFastLower : prevFastUpper;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;
      const atrStopMultVal = params.atrStopMult.value;

      const htfCandles = higherTimeframes["1h"];
      if (!htfCandles || htfCandles.length < 15) return null;

      const htfAtr = atr(htfCandles, 14);
      let atr1h = NaN;
      for (let j = htfCandles.length - 1; j >= 0; j--) {
        if (htfCandles[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      const stopDist = atr1h * atrStopMultVal;

      if (direction === "long") {
        return {
          stopLoss: currentCandle.c - stopDist,
          takeProfits: [{ price: currentCandle.c + TP_R_MULT * stopDist, pctOfPosition: TP_PCT }],
        };
      }

      return {
        stopLoss: currentCandle.c + stopDist,
        takeProfits: [{ price: currentCandle.c - TP_R_MULT * stopDist, pctOfPosition: TP_PCT }],
      };
    },
  };
}
