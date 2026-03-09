import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { adx as adxIndicator } from "../../../indicators/adx.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;
const TP1_PCT = 0.35;
const TP2_PCT = 0.35;

interface ExpansionAdxPartialTpParams {
  expansionThreshold: StrategyParam;
  adxThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  tp1RR: StrategyParam;
  tp2RR: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: ExpansionAdxPartialTpParams = {
  expansionThreshold: {
    value: 1.15, min: 1.0, max: 2.0, step: 0.05, optimizable: true,
    description: "ATR spike threshold: current ATR(14,15m) > X * SMA(ATR,20)",
  },
  adxThreshold: {
    value: 30, min: 18, max: 40, step: 2, optimizable: true,
    description: "4H ADX(14) must be below this for consolidation regime",
  },
  volMultiplier: {
    value: 1.25, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  tp1RR: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.5, optimizable: true,
    description: "TP1 take profit R:R ratio (closes 35% of position)",
  },
  tp2RR: {
    value: 3.0, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "TP2 take profit R:R ratio (closes 35%, remaining 30% trails). Must be > tp1RR",
  },
  atrTrailMult: {
    value: 2.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier for remaining 30% of position",
  },
  timeoutBars: {
    value: 60, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createExpansionAdxPartialTp(
  paramOverrides?: Partial<Record<keyof ExpansionAdxPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof ExpansionAdxPartialTpParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let volSmaCache: number[] | null = null;
  let atr15mCache: number[] | null = null;
  let atrSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfAdxCache4h: { adx: number[]; diPlus: number[]; diMinus: number[] } | null = null;
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
    name: "BTC 15m Breakout — Expansion ADX Partial-TP",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      volSmaCache = sma(candles.map(c => c.v), 20);
      atr15mCache = atr(candles, 14);
      atrSmaCache = sma(atr15mCache, 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfAdxCache4h = htf4hCandles.length > 0 ? adxIndicator(htf4hCandles, 14) : null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 35) return null;

      // --- 15m ATR expansion detection ---
      const atr15m = atr15mCache ?? atr(candles, 14);
      const atrSma20 = atrSmaCache ?? sma(atr15m, 20);
      const currentAtr = atr15m[index];
      const avgAtr = atrSma20[index];
      if (isNaN(currentAtr) || isNaN(avgAtr) || avgAtr <= 0) return null;

      const expThreshold = params.expansionThreshold.value;
      const expansionLevel = expThreshold * avgAtr;

      // --- HTF: 1H ATR (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- HTF: 4H ADX (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 30) return null;
      const adxResult = htfAdxCache4h ?? adxIndicator(htf4hRef, 14);
      const adx4h = findAdx4h(currentCandle.t, htf4hRef, adxResult.adx);
      if (isNaN(adx4h)) return null;

      const adxThresh = params.adxThreshold.value;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const prevCandle = candles[index - 1];
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;
      const risk = stopDist;

      // --- Diagnostics ---
      ctx.indicator("atr15m", currentAtr);
      ctx.indicator("avgAtr20", avgAtr);
      ctx.indicator("expansionLevel", expansionLevel);
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("close", close);

      // --- LONG: expansion + ADX consolidation + close > prev high + volume ---
      const longExpansion = ctx.track("L:atr_expansion", currentAtr > expansionLevel, currentAtr, expansionLevel);
      const longRegime = ctx.track("L:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const longBreakout = ctx.track("L:close_above_prev_high", close > prevCandle.h, close, prevCandle.h);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longExpansion && longRegime && longBreakout && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [
            { price: close + params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close + params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
          comment: "Expansion breakout long (ADX regime)",
        };
      }

      // --- SHORT: expansion + ADX consolidation + close < prev low + volume ---
      const shortExpansion = ctx.track("S:atr_expansion", currentAtr > expansionLevel, currentAtr, expansionLevel);
      const shortRegime = ctx.track("S:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const shortBreakout = ctx.track("S:close_below_prev_low", close < prevCandle.l, close, prevCandle.l);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortExpansion && shortRegime && shortBreakout && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [
            { price: close - params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close - params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
          comment: "Expansion breakout short (ADX regime)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      // Timeout first (mandatory — Rule 5)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // ATR trailing stop for remainder after partial TPs
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1h)) return null;

      const trailDist = params.atrTrailMult.value * atr1h;

      if (positionDirection === "long") {
        let highestHigh = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].h > highestHigh) highestHigh = candles[k].h;
        }
        const trailStop = highestHigh - trailDist;
        if (currentCandle.c < trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      } else {
        let lowestLow = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].l < lowestLow) lowestLow = candles[k].l;
        }
        const trailStop = lowestLow + trailDist;
        if (currentCandle.c > trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1h)) return null;

      const trailDist = params.atrTrailMult.value * atr1h;

      if (positionDirection === "long") {
        let highestHigh = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].h > highestHigh) highestHigh = candles[k].h;
        }
        return highestHigh - trailDist;
      } else {
        let lowestLow = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].l < lowestLow) lowestLow = candles[k].l;
        }
        return lowestLow + trailDist;
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
      const risk = stopDist;

      if (direction === "long") {
        return {
          stopLoss: close - stopDist,
          takeProfits: [
            { price: close + params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close + params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
        };
      } else {
        return {
          stopLoss: close + stopDist,
          takeProfits: [
            { price: close - params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close - params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
        };
      }
    },
  };
}
