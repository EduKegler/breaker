import type { Candle } from "../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../types/strategy.js";
import { donchian, type DonchianResult } from "../../indicators/donchian.js";
import { adx, type AdxResult } from "../../indicators/adx.js";
import { ema } from "../../indicators/ema.js";
import { atr } from "../../indicators/atr.js";
import { sma } from "../../indicators/sma.js";
import { bollingerBands } from "../../indicators/bollinger-bands.js";
import { keltner as keltnerFn } from "../../indicators/keltner.js";
import { detectSqueeze, type SqueezeResult } from "../../indicators/detect-squeeze.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

interface DonchianAdxParams {
  dcSlow: StrategyParam;
  dcFast: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  volMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: DonchianAdxParams = {
  dcSlow: { value: 50, min: 30, max: 60, step: 5, optimizable: true, description: "Slow Donchian period for entry" },
  dcFast: { value: 20, min: 10, max: 25, step: 5, optimizable: true, description: "Fast Donchian period for trailing exit" },
  adxThreshold: { value: 25, min: 20, max: 35, step: 5, optimizable: true, description: "ADX below this = consolidation" },
  atrStopMult: { value: 3.0, min: 3.0, max: 5.0, step: 0.5, optimizable: true, description: "ATR multiplier for safety stop (KB §1.6: min 3.0 for breakout)" },
  volMult: { value: 1.5, min: 1.0, max: 3.0, step: 0.5, optimizable: true, description: "Volume spike multiplier vs SMA(vol, 20) — KB §3.1 rule 3" },
  timeoutBars: { value: 24, min: 24, max: 96, step: 8, optimizable: true, description: "Bars before timeout exit (KB range: 24–96)" },
};

/**
 * Donchian ADX breakout strategy.
 *
 * Entry: Donchian breakout + low ADX (consolidation) + daily EMA regime filter.
 * Exit: Fast Donchian trailing channel.
 */
export function createDonchianAdx(
  paramOverrides?: Partial<Record<keyof DonchianAdxParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof DonchianAdxParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Pre-computed indicator caches (populated by init())
  let dcSlowCache: DonchianResult | null = null;
  let dcFastCache: DonchianResult | null = null;
  let adxCache: AdxResult | null = null;
  let htfAtrCache: number[] | null = null;
  let dailyEmaCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let squeezeCache: SqueezeResult | null = null;
  let htf1hCandles: Candle[] | null = null;
  let dailyCandles: Candle[] | null = null;

  return {
    name: "BTC 15m Breakout — Donchian ADX",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 52, "1h": 15, "1d": 201 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      dcSlowCache = donchian(candles, params.dcSlow.value);
      dcFastCache = donchian(candles, params.dcFast.value);
      adxCache = adx(candles, 14);
      volSmaCache = sma(candles.map((c) => c.v), 20);

      // Squeeze detection: BB(20, 2.0) inside KC(20, 1.5) — KB §7.1 rule 1
      const closes = candles.map((c) => c.c);
      const bbResult = bollingerBands(closes, 20, 2.0);
      const kcResult = keltnerFn(candles, 20, 20, 1.5);
      squeezeCache = detectSqueeze(bbResult, kcResult, 4);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache = atr(htf1hCandles, 14);
      }

      dailyCandles = higherTimeframes["1d"] ?? [];
      if (dailyCandles.length > 0) {
        const dailyCloses = dailyCandles.map((c) => c.c);
        dailyEmaCache = ema(dailyCloses, 200);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < params.dcSlow.value + 1) return null;

      const adxThresholdVal = params.adxThreshold.value;
      const atrStopMultVal = params.atrStopMult.value;

      // Use pre-computed caches if available, otherwise compute on the fly
      const dcSlow = dcSlowCache ?? donchian(candles.slice(0, index + 1), params.dcSlow.value);
      const prevSlowUpper = dcSlow.upper[index - 1];
      const prevSlowLower = dcSlow.lower[index - 1];

      if (isNaN(prevSlowUpper) || isNaN(prevSlowLower)) return null;

      const adxResult = adxCache ?? adx(candles.slice(0, index + 1), 14);
      const adxVal = adxResult.adx[index];
      if (isNaN(adxVal)) return null;

      // Gate: Active squeeze blocks entries (KB §7.1 rule 1)
      if (squeezeCache?.squeezeActive[index] ?? false) return null;

      // 1H ATR from higher timeframe — only use COMPLETED bars (Pine: [1] with lookahead_on)
      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;

      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      // A 1H bar starting at t is complete when t + 1H <= currentCandle.t
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      // Daily EMA 50 regime filter — only use COMPLETED daily bars
      const dailyCandlesRef = dailyCandles ?? higherTimeframes["1d"];
      if (!dailyCandlesRef || dailyCandlesRef.length < 201) return null;

      const ema50Daily = dailyEmaCache ?? ema(dailyCandlesRef.map((c) => c.c), 200);
      // A daily bar starting at t is complete when t + 1D <= currentCandle.t
      let dailyEma = NaN;
      for (let j = dailyCandlesRef.length - 1; j >= 0; j--) {
        if (dailyCandlesRef[j].t + MS_1D <= currentCandle.t && !isNaN(ema50Daily[j])) {
          dailyEma = ema50Daily[j];
          break;
        }
      }
      if (isNaN(dailyEma)) return null;

      const close = currentCandle.c;
      const volMult = params.volMult.value;

      // Volume confirmation (KB §3.1 rule 3): breakout bar must exceed recent avg
      const volSmaArr = volSmaCache ?? sma(candles.slice(0, index + 1).map((c) => c.v), 20);
      const avgVol = volSmaArr[index - 1]; // Previous bar SMA to avoid look-ahead
      const volConfirmed = !isNaN(avgVol) && currentCandle.v > avgVol * volMult;

      const stopDist = atr1h * atrStopMultVal;

      // Register indicator values for diagnostics
      ctx.indicator('adx', adxVal);
      ctx.indicator('atr1h', atr1h);
      ctx.indicator('dailyEma', dailyEma);
      ctx.indicator('close', close);
      ctx.indicator('prevSlowUpper', prevSlowUpper);
      ctx.indicator('prevSlowLower', prevSlowLower);

      // LONG conditions
      const longBreakout = ctx.track('L:breakout', close > prevSlowUpper, close, prevSlowUpper);
      const longAdx = ctx.track('L:adx_low', adxVal < adxThresholdVal, adxVal, adxThresholdVal);
      const longRegime = ctx.track('L:regime_bull', close > dailyEma, close, dailyEma);
      const longVol = ctx.track('L:vol_confirmed', volConfirmed, currentCandle.v, !isNaN(avgVol) ? avgVol * volMult : NaN);

      if (longBreakout && longAdx && longRegime && longVol) {
        return {
          direction: "long",
          entryPrice: prevSlowUpper,
          stopLoss: close - stopDist,
          takeProfits: [], // Uses trailing exit instead
          comment: "DC breakout long",
        };
      }

      // SHORT conditions
      const shortBreakout = ctx.track('S:breakout', close < prevSlowLower, close, prevSlowLower);
      const shortAdx = ctx.track('S:adx_low', adxVal < adxThresholdVal, adxVal, adxThresholdVal);
      const shortRegime = ctx.track('S:regime_bear', close < dailyEma, close, dailyEma);
      const shortVol = ctx.track('S:vol_confirmed', volConfirmed, currentCandle.v, !isNaN(avgVol) ? avgVol * volMult : NaN);

      if (shortBreakout && shortAdx && shortRegime && shortVol) {
        return {
          direction: "short",
          entryPrice: prevSlowLower,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "DC breakout short",
        };
      }

      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j]; break;
        }
      }
      if (isNaN(atr1h)) return null;

      const stopDist = atr1h * params.atrStopMult.value;
      const close = currentCandle.c;
      return {
        stopLoss: direction === "long" ? close - stopDist : close + stopDist,
        takeProfits: [], // Uses trailing exit
      };
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection } = ctx;
      if (!positionDirection || index < params.dcFast.value + 1) return null;

      const dcFast = dcFastCache ?? donchian(candles.slice(0, index + 1), params.dcFast.value);
      if (positionDirection === "long") return dcFast.lower[index - 1];
      if (positionDirection === "short") return dcFast.upper[index - 1];
      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout check (before trailing exit)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      if (index < params.dcFast.value + 1) return null;

      const dcFast = dcFastCache ?? donchian(candles.slice(0, index + 1), params.dcFast.value);
      const prevFastUpper = dcFast.upper[index - 1];
      const prevFastLower = dcFast.lower[index - 1];

      if (isNaN(prevFastUpper) || isNaN(prevFastLower)) return null;

      const currentCandle = candles[index];

      // Long exit: close below fast Donchian lower
      if (positionDirection === "long" && currentCandle.c < prevFastLower) {
        return { exit: true, comment: "DC Trail" };
      }

      // Short exit: close above fast Donchian upper
      if (positionDirection === "short" && currentCandle.c > prevFastUpper) {
        return { exit: true, comment: "DC Trail" };
      }

      return null;
    },
  };
}
