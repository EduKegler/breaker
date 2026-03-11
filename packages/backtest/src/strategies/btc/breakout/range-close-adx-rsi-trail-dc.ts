import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { rsi as rsiIndicator } from "../../../indicators/rsi.js";
import { donchian, type DonchianResult } from "../../../indicators/donchian.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface RangeCloseAdxRsiTrailDcParams {
  rangeLookback: StrategyParam;
  adxThreshold: StrategyParam;
  rsiThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  trailDcPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeCloseAdxRsiTrailDcParams = {
  rangeLookback: {
    value: 30, min: 10, max: 40, step: 5, optimizable: true,
    description: "Number of 15m bars to define range high/low for breakout",
  },
  adxThreshold: {
    value: 25, min: 15, max: 35, step: 5, optimizable: true,
    description: "Max ADX(14) 4H — below = consolidation regime (breakout ready)",
  },
  rsiThreshold: {
    value: 50, min: 45, max: 60, step: 1, optimizable: true,
    description: "RSI(14) 15m momentum gate: > thresh for longs, < (100-thresh) for shorts",
  },
  volMultiplier: {
    value: 2.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  trailDcPeriod: {
    value: 10, min: 5, max: 20, step: 1, optimizable: true,
    description: "Fast Donchian channel period for trailing exit (opposite band)",
  },
  timeoutBars: {
    value: 64, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createRangeCloseAdxRsiTrailDc(
  paramOverrides?: Partial<Record<keyof RangeCloseAdxRsiTrailDcParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeCloseAdxRsiTrailDcParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let rsiCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let trailDcCache: DonchianResult | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf4hAdxCache: AdxResult | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function findAdx4h(currentT: number, htfRef: Candle[], htfAdx: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT && !isNaN(htfAdx[j])) {
        return htfAdx[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Range ADX RSI Trail-DC",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      rsiCache = rsiIndicator(candles.map(c => c.c), 14);
      volSmaCache = sma(candles.map(c => c.v), 20);
      trailDcCache = donchian(candles, Math.round(params.trailDcPeriod.value));
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hAdxCache = htf4hCandles.length > 0 ? adxIndicator(htf4hCandles, 14) : null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const lookback = Math.round(params.rangeLookback.value);
      if (index < lookback + 14) return null;

      // --- Range detection: high/low of previous lookback bars (excludes current) ---
      let rangeHigh = -Infinity;
      let rangeLow = Infinity;
      for (let k = index - lookback; k < index; k++) {
        if (candles[k].h > rangeHigh) rangeHigh = candles[k].h;
        if (candles[k].l < rangeLow) rangeLow = candles[k].l;
      }

      // --- RSI(14, 15m) ---
      const rsi14 = rsiCache ? rsiCache[index] : NaN;

      // --- HTF: 1H ATR for stop (anti-repaint: completed bar only) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- 4H ADX regime (anti-repaint: completed bar only) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 28) return null;
      const htfAdx = htf4hAdxCache ?? adxIndicator(htf4hRef, 14);
      const adx4h = findAdx4h(currentCandle.t, htf4hRef, htfAdx.adx);
      if (isNaN(adx4h)) return null;

      const adxThresh = params.adxThreshold.value;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopDist = atr1h * params.atrStopMult.value;
      const rsiThresh = params.rsiThreshold.value;

      // --- Diagnostics ---
      ctx.indicator("rangeHigh", rangeHigh);
      ctx.indicator("rangeLow", rangeLow);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("rsi14", rsi14);
      ctx.indicator("volAvg20", volAvg20);

      // --- LONG: close > rangeHigh + ADX < thresh + RSI > rsiThresh + volume ---
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longAdx = ctx.track("L:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const longRsi = ctx.track("L:rsi_momentum", !isNaN(rsi14) && rsi14 > rsiThresh, rsi14, rsiThresh);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreakout && longAdx && longRsi && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Range breakout long (ADX+RSI)",
        };
      }

      // --- SHORT: close < rangeLow + ADX < thresh + RSI < (100-rsiThresh) + volume ---
      const shortBreakout = ctx.track("S:close_below_range", close < rangeLow, close, rangeLow);
      const shortAdx = ctx.track("S:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const shortRsi = ctx.track("S:rsi_momentum", !isNaN(rsi14) && rsi14 < (100 - rsiThresh), rsi14, 100 - rsiThresh);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreakout && shortAdx && shortRsi && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Range breakout short (ADX+RSI)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory — Rule 5)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Trailing Donchian exit: use previous bar's channel to avoid lookahead
      const dcPeriod = Math.round(params.trailDcPeriod.value);
      if (index < dcPeriod + 1) return null;
      const dc = trailDcCache ?? donchian(candles.slice(0, index + 1), dcPeriod);

      if (positionDirection === "long") {
        const dcLower = dc.lower[index - 1];
        if (!isNaN(dcLower) && currentCandle.c < dcLower) {
          return { exit: true, comment: "Trail DC" };
        }
      } else {
        const dcUpper = dc.upper[index - 1];
        if (!isNaN(dcUpper) && currentCandle.c > dcUpper) {
          return { exit: true, comment: "Trail DC" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection } = ctx;
      if (!positionDirection) return null;

      const dcPeriod = Math.round(params.trailDcPeriod.value);
      if (index < dcPeriod) return null;
      const dc = trailDcCache ?? donchian(candles.slice(0, index + 1), dcPeriod);

      if (positionDirection === "long") {
        return dc.lower[index] ?? null;
      } else {
        return dc.upper[index] ?? null;
      }
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1h)) return null;

      const stopDist = atr1h * params.atrStopMult.value;
      const close = currentCandle.c;

      if (direction === "long") {
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
