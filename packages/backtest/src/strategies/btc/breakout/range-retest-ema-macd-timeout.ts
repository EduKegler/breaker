import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { macd } from "../../../indicators/macd.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

const EMA_PERIOD = 50;
const RETEST_TOLERANCE = 0.5;

interface RangeRetestEmaMacdTimeoutParams {
  rangeLookback: StrategyParam;
  rangeAtrThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  retestWindow: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeRetestEmaMacdTimeoutParams = {
  rangeLookback: {
    value: 30, min: 10, max: 40, step: 5, optimizable: true,
    description: "Bars to look back for range high/low definition",
  },
  rangeAtrThreshold: {
    value: 3.5, min: 2.0, max: 10.0, step: 0.5, optimizable: true,
    description: "Max range width as multiple of ATR(14) 15m — below = consolidation",
  },
  volMultiplier: {
    value: 1.25, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  retestWindow: {
    value: 20, min: 4, max: 28, step: 2, optimizable: true,
    description: "Bars to wait for retest after initial breakout",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  timeoutBars: {
    value: 72, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createRangeRetestEmaMacdTimeout(
  paramOverrides?: Partial<Record<keyof RangeRetestEmaMacdTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeRetestEmaMacdTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let macdHistCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htf4hEmaCache: number[] | null = null;

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

  function findLast4hIdx(currentT: number, htfRef: Candle[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT) {
        return j;
      }
    }
    return -1;
  }

  return {
    name: "BTC 15m Breakout — Range Retest EMA MACD Timeout",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 60 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      volSmaCache = sma(candles.map(c => c.v), 20);
      const closes = candles.map(c => c.c);
      const macdResult = macd(closes, 12, 26, 9);
      macdHistCache = macdResult.histogram;
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htf4hEmaCache = htf4hCandles.length > 0
        ? ema(htf4hCandles.map(c => c.c), EMA_PERIOD)
        : null;
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

      // --- 4H EMA regime (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < EMA_PERIOD + 1) return null;
      const ema4h = htf4hEmaCache ?? ema(htf4hRef.map(c => c.c), EMA_PERIOD);
      const last4hIdx = findLast4hIdx(currentCandle.t, htf4hRef);
      if (last4hIdx < 0) return null;
      const ema4hVal = ema4h[last4hIdx];
      const htf4hClose = htf4hRef[last4hIdx].c;
      if (isNaN(ema4hVal)) return null;

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
      ctx.indicator("ema4h", ema4hVal);
      ctx.indicator("htf4hClose", htf4hClose);
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
          // Fall through to check new breakout
        } else {
          const level = pendingRetest.level;
          const dir = pendingRetest.direction;
          const atr1hBk = pendingRetest.atr1hAtBreakout;
          const stopDist = atr1hBk * stopMult;
          const retestZone = RETEST_TOLERANCE * atr1hBk;

          if (dir === "long") {
            const retestApproach = ctx.track("L:retest_approach", currentCandle.l <= level + retestZone, currentCandle.l, level + retestZone);
            const retestHold = ctx.track("L:retest_hold", close >= level, close, level);
            const macdConfirm = ctx.track("L:macd_positive", !isNaN(macdHist) && macdHist > 0, macdHist, 0);

            if (retestApproach && retestHold && macdConfirm) {
              pendingRetest = null;
              return {
                direction: "long",
                entryPrice: null,
                stopLoss: close - stopDist,
                takeProfits: [],
                comment: "Range retest long (EMA+MACD)",
              };
            }

            if (close < level - atr1hBk) {
              pendingRetest = null;
            } else {
              return null;
            }
          } else {
            const retestApproach = ctx.track("S:retest_approach", currentCandle.h >= level - retestZone, currentCandle.h, level - retestZone);
            const retestHold = ctx.track("S:retest_hold", close <= level, close, level);
            const macdConfirm = ctx.track("S:macd_negative", !isNaN(macdHist) && macdHist < 0, macdHist, 0);

            if (retestApproach && retestHold && macdConfirm) {
              pendingRetest = null;
              return {
                direction: "short",
                entryPrice: null,
                stopLoss: close + stopDist,
                takeProfits: [],
                comment: "Range retest short (EMA+MACD)",
              };
            }

            if (close > level + atr1hBk) {
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
      const threshold = params.rangeAtrThreshold.value;
      const isConsolidated = normalizedWidth < threshold;

      ctx.indicator("rangeHigh", rangeHigh);
      ctx.indicator("rangeLow", rangeLow);
      ctx.indicator("normalizedWidth", normalizedWidth);

      // --- LONG breakout detection ---
      const longConsolidation = ctx.track("L:consolidated", isConsolidated, normalizedWidth, threshold);
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longRegime = ctx.track("L:above_ema4h", htf4hClose > ema4hVal, htf4hClose, ema4hVal);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longConsolidation && longBreakout && longRegime && longVol) {
        pendingRetest = {
          direction: "long",
          level: rangeHigh,
          breakoutBar: index,
          atr1hAtBreakout: atr1h,
        };
        return null;
      }

      // --- SHORT breakout detection ---
      const shortConsolidation = ctx.track("S:consolidated", isConsolidated, normalizedWidth, threshold);
      const shortBreakout = ctx.track("S:close_below_range", close < rangeLow, close, rangeLow);
      const shortRegime = ctx.track("S:below_ema4h", htf4hClose < ema4hVal, htf4hClose, ema4hVal);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortConsolidation && shortBreakout && shortRegime && shortVol) {
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
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null || ctx.positionEntryPrice === null) return null;

      // Timeout first (mandatory — Rule 5)
      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null || ctx.positionEntryPrice === null) return null;

      const htf1hRef = htf1hCandles ?? ctx.higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(ctx.currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = params.atrStopMult.value * atr1hVal;
      return ctx.positionDirection === "long"
        ? ctx.positionEntryPrice - stopDist
        : ctx.positionEntryPrice + stopDist;
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
