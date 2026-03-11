import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { macd } from "../../../indicators/macd.js";
import { adx as computeAdx } from "../../../indicators/adx.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

// Fixed constants (not optimizable)
const RETEST_TOLERANCE = 2.0;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

interface RangeRetestAdxMacdTimeoutParams {
  rangeLookback: StrategyParam;
  rangeAtrThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  retestWindow: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeRetestAdxMacdTimeoutParams = {
  rangeLookback: {
    value: 30, min: 10, max: 50, step: 5, optimizable: true,
    description: "Bars to look back for range high/low definition",
  },
  rangeAtrThreshold: {
    value: 4, min: 2.0, max: 10.0, step: 0.5, optimizable: true,
    description: "Max range width as multiple of ATR(14) 15m — below = consolidation",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  retestWindow: {
    value: 10, min: 4, max: 28, step: 2, optimizable: true,
    description: "Bars to wait for retest after initial breakout",
  },
  adxThreshold: {
    value: 20, min: 15, max: 40, step: 5, optimizable: true,
    description: "Max ADX(14) 4H — below = consolidation regime (breakout ready)",
  },
  atrStopMult: {
    value: 3, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  timeoutBars: {
    value: 76, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createRangeRetestAdxMacdTimeout(
  paramOverrides?: Partial<Record<keyof RangeRetestAdxMacdTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeRetestAdxMacdTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let macdHistCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfAdxCache4h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;

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

  function findAdx4h(currentT: number, htfRef: Candle[], adxArr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT && !isNaN(adxArr[j])) {
        return adxArr[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Range Retest ADX MACD Timeout",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      volSmaCache = sma(candles.map(c => c.v), 20);
      const closes = candles.map(c => c.c);
      macdHistCache = macd(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL).histogram;
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAdxCache4h = htf4hCandles.length > 0 ? computeAdx(htf4hCandles, 14).adx : null;
      pendingRetest = null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const lookback = Math.round(params.rangeLookback.value);
      if (index < lookback + MACD_SLOW) return null;

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

      // --- HTF: 4H ADX regime (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 30) return null;
      const adx4hArr = htfAdxCache4h ?? computeAdx(htf4hRef, 14).adx;
      const adx4hVal = findAdx4h(currentCandle.t, htf4hRef, adx4hArr);

      // --- MACD histogram (15m) ---
      const macdHist = macdHistCache ? macdHistCache[index] : NaN;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ? volSmaCache[index] : NaN;
      const volThreshold = !isNaN(volSma) ? params.volMultiplier.value * volSma : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const retestWin = Math.round(params.retestWindow.value);
      const adxThresh = params.adxThreshold.value;
      const is4hLowAdx = !isNaN(adx4hVal) && adx4hVal < adxThresh;

      // --- Diagnostics ---
      ctx.indicator("atr15m", atr15mVal);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("adx4h", adx4hVal);
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
                comment: "Range retest long (ADX+MACD)",
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
                comment: "Range retest short (ADX+MACD)",
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
      const longRegime = ctx.track("L:4h_low_adx", is4hLowAdx, adx4hVal, adxThresh);
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
      const shortRegime = ctx.track("S:4h_low_adx", is4hLowAdx, adx4hVal, adxThresh);
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
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * params.atrStopMult.value;
      const close = currentCandle.c;

      if (direction === "long") {
        return {
          stopLoss: close - stopDist,
          takeProfits: [],
        };
      } else {
        return {
          stopLoss: close + stopDist,
          takeProfits: [],
        };
      }
    },
  };
}
