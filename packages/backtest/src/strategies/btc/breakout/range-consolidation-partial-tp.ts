import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

const TP1_PCT = 0.35;
const TP2_PCT = 0.35;
const TP2_RR_MULT = 2.0;
const ATR_TRAIL_MULT = 2.5;

interface RangeConsolidationPartialTpParams {
  rangePeriod: StrategyParam;
  rangeThreshold: StrategyParam;
  consLookback: StrategyParam;
  consThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  tp1RR: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeConsolidationPartialTpParams = {
  rangePeriod: {
    value: 25, min: 10, max: 40, step: 5, optimizable: true,
    description: "Number of 15m bars to define the consolidation range",
  },
  rangeThreshold: {
    value: 3, min: 2.0, max: 8.0, step: 0.5, optimizable: true,
    description: "Max range width as multiple of ATR(14, 15m)",
  },
  consLookback: {
    value: 10, min: 4, max: 12, step: 2, optimizable: true,
    description: "Number of completed 4H bars for consolidation check",
  },
  consThreshold: {
    value: 3, min: 2.0, max: 8.0, step: 0.5, optimizable: true,
    description: "4H consolidation range / ATR(14, 4H) threshold",
  },
  volMultiplier: {
    value: 2.25, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  tp1RR: {
    value: 1, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "TP1 target as R:R multiple (TP2 = 2x this value)",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createRangeConsolidationPartialTp(
  paramOverrides?: Partial<Record<keyof RangeConsolidationPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeConsolidationPartialTpParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfAtrCache4h: number[] | null = null;
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

  function findLast4hIdx(currentT: number, htfRef: Candle[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT) {
        return j;
      }
    }
    return -1;
  }

  return {
    name: "BTC 15m Breakout — Range Consolidation Partial-TP",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache1h = atr(htf1hCandles, 14);
      }
      if (htf4hCandles.length > 0) {
        htfAtrCache4h = atr(htf4hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const rangePeriod = Math.round(params.rangePeriod.value);
      if (index < rangePeriod + 14) return null;

      // --- 15m ATR for range width normalization ---
      const atr15m = atr15mCache ?? atr(candles, 14);
      const currentAtr15m = atr15m[index];
      if (isNaN(currentAtr15m) || currentAtr15m === 0) return null;

      // --- Define range: high/low over last rangePeriod bars ---
      let rangeHigh = -Infinity;
      let rangeLow = Infinity;
      for (let i = index - rangePeriod; i < index; i++) {
        if (candles[i].h > rangeHigh) rangeHigh = candles[i].h;
        if (candles[i].l < rangeLow) rangeLow = candles[i].l;
      }
      const rangeWidth = (rangeHigh - rangeLow) / currentAtr15m;
      const rangeValid = rangeWidth < params.rangeThreshold.value;

      // --- HTF: 1H ATR (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- HTF: 4H Consolidation regime (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 30) return null;
      const htfAtr4h = htfAtrCache4h ?? atr(htf4hRef, 14);
      const last4hIdx = findLast4hIdx(currentCandle.t, htf4hRef);
      const consLookback = Math.round(params.consLookback.value);
      if (last4hIdx < consLookback) return null;

      const atr4hVal = htfAtr4h[last4hIdx];
      if (isNaN(atr4hVal) || atr4hVal === 0) return null;

      let htfRangeHigh = -Infinity;
      let htfRangeLow = Infinity;
      for (let j = last4hIdx - consLookback + 1; j <= last4hIdx; j++) {
        htfRangeHigh = Math.max(htfRangeHigh, htf4hRef[j].h);
        htfRangeLow = Math.min(htfRangeLow, htf4hRef[j].l);
      }
      const htfRange = htfRangeHigh - htfRangeLow;
      const consThresholdAbs = params.consThreshold.value * atr4hVal;
      const consolidated = htfRange < consThresholdAbs;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const risk = atr1h * stopMult;

      // --- Diagnostics ---
      ctx.indicator("rangeHigh", rangeHigh);
      ctx.indicator("rangeLow", rangeLow);
      ctx.indicator("rangeWidth", rangeWidth);
      ctx.indicator("atr15m", currentAtr15m);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("atr4h", atr4hVal);
      ctx.indicator("htfRange", htfRange);
      ctx.indicator("consThresholdAbs", consThresholdAbs);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("close", close);

      // --- LONG: range breakout up + 4H consolidation + volume ---
      const longRange = ctx.track("L:range_valid", rangeValid, rangeWidth, params.rangeThreshold.value);
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longRegime = ctx.track("L:4h_consolidated", consolidated, htfRange, consThresholdAbs);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longRange && longBreakout && longRegime && longVol) {
        const tp1Price = close + params.tp1RR.value * risk;
        const tp2Price = close + TP2_RR_MULT * params.tp1RR.value * risk;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - risk,
          takeProfits: [
            { price: tp1Price, pctOfPosition: TP1_PCT },
            { price: tp2Price, pctOfPosition: TP2_PCT },
          ],
          comment: "Range breakout long (4H consolidation)",
        };
      }

      // --- SHORT: range breakout down + 4H consolidation + volume ---
      const shortRange = ctx.track("S:range_valid", rangeValid, rangeWidth, params.rangeThreshold.value);
      const shortBreakout = ctx.track("S:close_below_range", close < rangeLow, close, rangeLow);
      const shortRegime = ctx.track("S:4h_consolidated", consolidated, htfRange, consThresholdAbs);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortRange && shortBreakout && shortRegime && shortVol) {
        const tp1Price = close - params.tp1RR.value * risk;
        const tp2Price = close - TP2_RR_MULT * params.tp1RR.value * risk;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + risk,
          takeProfits: [
            { price: tp1Price, pctOfPosition: TP1_PCT },
            { price: tp2Price, pctOfPosition: TP2_PCT },
          ],
          comment: "Range breakout short (4H consolidation)",
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

      const trailDist = ATR_TRAIL_MULT * atr1h;

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

      const trailDist = ATR_TRAIL_MULT * atr1h;

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

      const risk = atr1h * params.atrStopMult.value;
      const close = currentCandle.c;
      const tp1RR = params.tp1RR.value;
      const tp2RR = TP2_RR_MULT * tp1RR;

      if (direction === "long") {
        return {
          stopLoss: close - risk,
          takeProfits: [
            { price: close + tp1RR * risk, pctOfPosition: TP1_PCT },
            { price: close + tp2RR * risk, pctOfPosition: TP2_PCT },
          ],
        };
      } else {
        return {
          stopLoss: close + risk,
          takeProfits: [
            { price: close - tp1RR * risk, pctOfPosition: TP1_PCT },
            { price: close - tp2RR * risk, pctOfPosition: TP2_PCT },
          ],
        };
      }
    },
  };
}
