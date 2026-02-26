import type { Strategy, StrategyContext, StrategyParam, Signal } from "../types/strategy.js";
import { donchian } from "../indicators/donchian.js";
import { adx } from "../indicators/adx.js";
import { ema } from "../indicators/ema.js";
import { atr } from "../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

export interface DonchianAdxParams {
  dcSlow: StrategyParam;
  dcFast: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  maxTradesDay: StrategyParam;
}

const DEFAULT_PARAMS: DonchianAdxParams = {
  dcSlow: { value: 50, min: 30, max: 60, step: 5, optimizable: true, description: "Slow Donchian period for entry" },
  dcFast: { value: 20, min: 10, max: 25, step: 5, optimizable: true, description: "Fast Donchian period for trailing exit" },
  adxThreshold: { value: 25, min: 20, max: 35, step: 5, optimizable: true, description: "ADX below this = consolidation" },
  atrStopMult: { value: 2.0, min: 1.5, max: 3.0, step: 0.5, optimizable: true, description: "ATR multiplier for safety stop" },
  maxTradesDay: { value: 3, min: 2, max: 5, step: 1, optimizable: false, description: "Max trades per day" },
};

/**
 * Donchian ADX breakout strategy — TypeScript port of Pine Script.
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

  return {
    name: "BTC 15m Breakout — Donchian ADX",
    params,
    requiredTimeframes: ["1h", "1d"],

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < params.dcSlow.value + 1) return null;

      const dcSlowVal = params.dcSlow.value;
      const dcFastVal = params.dcFast.value;
      const adxThresholdVal = params.adxThreshold.value;
      const atrStopMultVal = params.atrStopMult.value;

      // Compute indicators up to current bar
      const lookback = candles.slice(0, index + 1);

      // Slow Donchian
      const dcSlowResult = donchian(lookback, dcSlowVal);
      const prevSlowUpper = dcSlowResult.upper[index - 1];
      const prevSlowLower = dcSlowResult.lower[index - 1];

      if (isNaN(prevSlowUpper) || isNaN(prevSlowLower)) return null;

      // ADX
      const adxResult = adx(lookback, 14);
      const adxVal = adxResult.adx[index];
      if (isNaN(adxVal)) return null;

      // 1H ATR from higher timeframe — only use COMPLETED bars (Pine: [1] with lookahead_on)
      const htfCandles = higherTimeframes["1h"];
      if (!htfCandles || htfCandles.length < 15) return null;

      const htfAtr = atr(htfCandles, 14);
      // A 1H bar starting at t is complete when t + 1H <= currentCandle.t
      let atr1h = NaN;
      for (let j = htfCandles.length - 1; j >= 0; j--) {
        if (htfCandles[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      // Daily EMA 50 regime filter — only use COMPLETED daily bars
      const dailyCandles = higherTimeframes["1d"];
      if (!dailyCandles || dailyCandles.length < 51) return null;

      const dailyCloses = dailyCandles.map((c) => c.c);
      const ema50Daily = ema(dailyCloses, 50);
      // A daily bar starting at t is complete when t + 1D <= currentCandle.t
      let dailyEma = NaN;
      for (let j = dailyCandles.length - 1; j >= 0; j--) {
        if (dailyCandles[j].t + MS_1D <= currentCandle.t && !isNaN(ema50Daily[j])) {
          dailyEma = ema50Daily[j];
          break;
        }
      }
      if (isNaN(dailyEma)) return null;

      const regimeBull = currentCandle.c > dailyEma;
      const regimeBear = currentCandle.c < dailyEma;

      const stopDist = atr1h * atrStopMultVal;

      // LONG signal: breakout above slow Donchian upper, low ADX, bullish regime
      if (
        currentCandle.c > prevSlowUpper &&
        adxVal < adxThresholdVal &&
        regimeBull
      ) {
        return {
          direction: "long",
          entryPrice: null, // Market order
          stopLoss: currentCandle.c - stopDist,
          takeProfits: [], // Uses trailing exit instead
          comment: "DC breakout long",
        };
      }

      // SHORT signal: breakout below slow Donchian lower, low ADX, bearish regime
      if (
        currentCandle.c < prevSlowLower &&
        adxVal < adxThresholdVal &&
        regimeBear
      ) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: currentCandle.c + stopDist,
          takeProfits: [],
          comment: "DC breakout short",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, positionDirection } = ctx;
      if (!positionDirection || index < params.dcFast.value + 1) return null;

      const lookback = candles.slice(0, index + 1);
      const dcFastResult = donchian(lookback, params.dcFast.value);
      const prevFastUpper = dcFastResult.upper[index - 1];
      const prevFastLower = dcFastResult.lower[index - 1];

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
