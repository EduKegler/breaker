import type { Candle } from "../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../types/strategy.js";
import { donchian, type DonchianResult } from "../indicators/donchian.js";
import { adx, type AdxResult } from "../indicators/adx.js";
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
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: DonchianAdxParams = {
  dcSlow: { value: 50, min: 30, max: 60, step: 5, optimizable: true, description: "Slow Donchian period for entry" },
  dcFast: { value: 20, min: 10, max: 25, step: 5, optimizable: true, description: "Fast Donchian period for trailing exit" },
  adxThreshold: { value: 25, min: 20, max: 35, step: 5, optimizable: true, description: "ADX below this = consolidation" },
  atrStopMult: { value: 2.0, min: 1.5, max: 3.0, step: 0.5, optimizable: true, description: "ATR multiplier for safety stop" },
  maxTradesDay: { value: 3, min: 2, max: 5, step: 1, optimizable: false, description: "Max trades per day" },
  timeoutBars: { value: 20, min: 10, max: 40, step: 5, optimizable: true, description: "Bars before timeout exit" },
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

  // Pre-computed indicator caches (populated by init())
  let dcSlowCache: DonchianResult | null = null;
  let dcFastCache: DonchianResult | null = null;
  let adxCache: AdxResult | null = null;
  let htfAtrCache: number[] | null = null;
  let dailyEmaCache: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let dailyCandles: Candle[] | null = null;

  return {
    name: "BTC 15m Breakout — Donchian ADX",
    params,
    requiredTimeframes: ["1h", "1d"],

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      dcSlowCache = donchian(candles, params.dcSlow.value);
      dcFastCache = donchian(candles, params.dcFast.value);
      adxCache = adx(candles, 14);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache = atr(htf1hCandles, 14);
      }

      dailyCandles = higherTimeframes["1d"] ?? [];
      if (dailyCandles.length > 0) {
        const dailyCloses = dailyCandles.map((c) => c.c);
        dailyEmaCache = ema(dailyCloses, 50);
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
      if (!dailyCandlesRef || dailyCandlesRef.length < 51) return null;

      const ema50Daily = dailyEmaCache ?? ema(dailyCandlesRef.map((c) => c.c), 50);
      // A daily bar starting at t is complete when t + 1D <= currentCandle.t
      let dailyEma = NaN;
      for (let j = dailyCandlesRef.length - 1; j >= 0; j--) {
        if (dailyCandlesRef[j].t + MS_1D <= currentCandle.t && !isNaN(ema50Daily[j])) {
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
