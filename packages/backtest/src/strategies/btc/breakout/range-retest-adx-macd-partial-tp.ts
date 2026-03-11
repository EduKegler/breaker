import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { macd } from "../../../indicators/macd.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

const RANGE_ATR_THRESHOLD = 3.5; // constant — range width < X * ATR(14,15m) = consolidation
const RETEST_TOLERANCE = 1.0;
const RETEST_INVALIDATION = 1.5;
const TP1_PCT = 0.35;
const TP2_PCT = 0.35;

interface RangeRetestAdxMacdPartialTpParams {
  rangeLookback: StrategyParam;
  volMultiplier: StrategyParam;
  retestWindow: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  tp1RR: StrategyParam;
  tp2RR: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeRetestAdxMacdPartialTpParams = {
  rangeLookback: {
    value: 30, min: 10, max: 50, step: 5, optimizable: true,
    description: "Bars to look back for range high/low definition",
  },
  volMultiplier: {
    value: 2.0, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  retestWindow: {
    value: 12, min: 4, max: 28, step: 2, optimizable: true,
    description: "Bars to wait for retest after initial breakout",
  },
  adxThreshold: {
    value: 25, min: 15, max: 40, step: 5, optimizable: true,
    description: "Max ADX(14) 4H — below = consolidation regime (breakout ready)",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  tp1RR: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "TP1 target as R:R multiple (closes 35% of position)",
  },
  tp2RR: {
    value: 3.0, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "TP2 target as R:R multiple (closes 35%, remaining 30% trails)",
  },
  timeoutBars: {
    value: 72, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createRangeRetestAdxMacdPartialTp(
  paramOverrides?: Partial<Record<keyof RangeRetestAdxMacdPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeRetestAdxMacdPartialTpParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let macdHistCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htf4hAdxCache: AdxResult | null = null;

  let pendingRetest: {
    direction: "long" | "short";
    level: number;
    breakoutBar: number;
    atr1hAtBreakout: number;
  } | null = null;

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
    name: "BTC 15m Breakout — Range Retest ADX MACD Partial-TP",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      volSmaCache = sma(candles.map(c => c.v), 20);
      const closes = candles.map(c => c.c);
      const macdResult = macd(closes, 12, 26, 9);
      macdHistCache = macdResult.histogram;
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htf4hAdxCache = htf4hCandles.length > 0 ? adxIndicator(htf4hCandles, 14) : null;
      pendingRetest = null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const lookback = Math.round(params.rangeLookback.value);
      if (index < lookback + 26) return null;

      if (ctx.positionDirection) {
        pendingRetest = null;
        return null;
      }

      // --- ATR(14, 15m) for range normalization ---
      const atr15mVal = atr15mCache ? atr15mCache[index] : NaN;
      if (isNaN(atr15mVal) || atr15mVal <= 0) return null;

      // --- HTF: 1H ATR for stop (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1h)) return null;

      // --- 4H ADX regime filter (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 28) return null;
      const htfAdx = htf4hAdxCache ?? adxIndicator(htf4hRef, 14);
      const adx4h = findAdx4h(currentCandle.t, htf4hRef, htfAdx.adx);
      if (isNaN(adx4h)) return null;

      const adxThresh = params.adxThreshold.value;

      // --- MACD histogram (15m) ---
      const macdHist = macdHistCache ? macdHistCache[index] : NaN;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ? volSmaCache[index] : NaN;
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volSma) ? volMult * volSma : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const retestWin = Math.round(params.retestWindow.value);

      // --- Diagnostics ---
      ctx.indicator("atr15m", atr15mVal);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("macdHist", macdHist);
      ctx.indicator("volSma20", volSma);

      // ==========================================================
      // PHASE 2: Check pending retest for entry
      // ==========================================================
      if (pendingRetest) {
        const barsSinceBreakout = index - pendingRetest.breakoutBar;
        ctx.indicator("retestBarsWaiting", barsSinceBreakout);

        if (barsSinceBreakout > retestWin) {
          pendingRetest = null;
        } else {
          const level = pendingRetest.level;
          const dir = pendingRetest.direction;
          const atr1hBk = pendingRetest.atr1hAtBreakout;
          const stopDist = atr1hBk * stopMult;
          const risk = stopDist;

          if (dir === "long") {
            const retestZone = level + RETEST_TOLERANCE * atr1hBk;
            const retestApproach = ctx.track("L:retest_approach", currentCandle.l <= retestZone, currentCandle.l, retestZone);
            const retestHold = ctx.track("L:retest_hold", close > level, close, level);
            const macdConfirm = ctx.track("L:macd_positive", !isNaN(macdHist) && macdHist > 0, macdHist, 0);

            if (retestApproach && retestHold && macdConfirm) {
              pendingRetest = null;
              return {
                direction: "long",
                entryPrice: null,
                stopLoss: close - stopDist,
                takeProfits: [
                  { price: close + params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
                  { price: close + params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
                ],
                comment: "Range retest long (ADX+MACD+Partial-TP)",
              };
            }

            if (close < level - RETEST_INVALIDATION * atr1hBk) {
              pendingRetest = null;
            } else {
              return null;
            }
          } else {
            const retestZone = level - RETEST_TOLERANCE * atr1hBk;
            const retestApproach = ctx.track("S:retest_approach", currentCandle.h >= retestZone, currentCandle.h, retestZone);
            const retestHold = ctx.track("S:retest_hold", close < level, close, level);
            const macdConfirm = ctx.track("S:macd_negative", !isNaN(macdHist) && macdHist < 0, macdHist, 0);

            if (retestApproach && retestHold && macdConfirm) {
              pendingRetest = null;
              return {
                direction: "short",
                entryPrice: null,
                stopLoss: close + stopDist,
                takeProfits: [
                  { price: close - params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
                  { price: close - params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
                ],
                comment: "Range retest short (ADX+MACD+Partial-TP)",
              };
            }

            if (close > level + RETEST_INVALIDATION * atr1hBk) {
              pendingRetest = null;
            } else {
              return null;
            }
          }
        }
      }

      // ==========================================================
      // PHASE 1: Detect breakout (sets pending retest)
      // ==========================================================
      let rangeHigh = -Infinity;
      let rangeLow = Infinity;
      for (let k = index - lookback; k < index; k++) {
        if (candles[k].h > rangeHigh) rangeHigh = candles[k].h;
        if (candles[k].l < rangeLow) rangeLow = candles[k].l;
      }
      const rangeWidth = rangeHigh - rangeLow;
      const normalizedWidth = rangeWidth / atr15mVal;
      const isConsolidated = normalizedWidth < RANGE_ATR_THRESHOLD;

      ctx.indicator("rangeHigh", rangeHigh);
      ctx.indicator("rangeLow", rangeLow);
      ctx.indicator("normalizedWidth", normalizedWidth);

      // --- LONG breakout detection ---
      const longConsolidation = ctx.track("L:consolidated", isConsolidated, normalizedWidth, RANGE_ATR_THRESHOLD);
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longAdx = ctx.track("L:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);
      const longMacd = ctx.track("L:macd_positive", !isNaN(macdHist) && macdHist > 0, macdHist, 0);

      if (longConsolidation && longBreakout && longAdx && longVol && longMacd) {
        pendingRetest = {
          direction: "long",
          level: rangeHigh,
          breakoutBar: index,
          atr1hAtBreakout: atr1h,
        };
        return null;
      }

      // --- SHORT breakout detection ---
      const shortConsolidation = ctx.track("S:consolidated", isConsolidated, normalizedWidth, RANGE_ATR_THRESHOLD);
      const shortBreakout = ctx.track("S:close_below_range", close < rangeLow, close, rangeLow);
      const shortAdx = ctx.track("S:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);
      const shortMacd = ctx.track("S:macd_negative", !isNaN(macdHist) && macdHist < 0, macdHist, 0);

      if (shortConsolidation && shortBreakout && shortAdx && shortVol && shortMacd) {
        pendingRetest = {
          direction: "short",
          level: rangeLow,
          breakoutBar: index,
          atr1hAtBreakout: atr1h,
        };
        return null;
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

      // ATR trailing stop for remainder position (after partial TPs)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const trailDist = params.atrStopMult.value * atr1hVal;

      if (positionDirection === "long") {
        let highestHigh = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].h > highestHigh) highestHigh = candles[k].h;
        }
        const trailStop = highestHigh - trailDist;
        ctx.indicator("trailStop", trailStop);
        if (currentCandle.c < trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      } else {
        let lowestLow = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].l < lowestLow) lowestLow = candles[k].l;
        }
        const trailStop = lowestLow + trailDist;
        ctx.indicator("trailStop", trailStop);
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
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const trailDist = params.atrStopMult.value * atr1hVal;

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
