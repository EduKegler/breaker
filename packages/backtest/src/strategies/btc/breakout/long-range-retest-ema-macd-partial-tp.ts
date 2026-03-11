import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { macd } from "../../../indicators/macd.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

const EMA_PERIOD = 50;
const TP1_PCT = 0.35;
const TP2_PCT = 0.35;
const ATR_TRAIL_MULT = 2.5;
const RETEST_TOLERANCE = 0.5;

interface LongRangeRetestEmaMacdPartialTpParams {
  rangeLookback: StrategyParam;
  rangeAtrThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  retestWindow: StrategyParam;
  atrStopMult: StrategyParam;
  tp1RR: StrategyParam;
  tp2RR: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: LongRangeRetestEmaMacdPartialTpParams = {
  rangeLookback: {
    value: 25, min: 10, max: 40, step: 5, optimizable: true,
    description: "Bars to look back for range high/low definition",
  },
  rangeAtrThreshold: {
    value: 3.0, min: 1.5, max: 6.0, step: 0.5, optimizable: true,
    description: "Max range width as multiple of ATR(14) 15m — below = consolidation",
  },
  volMultiplier: {
    value: 2.0, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  retestWindow: {
    value: 12, min: 4, max: 20, step: 2, optimizable: true,
    description: "Bars to wait for retest after initial breakout",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  tp1RR: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "TP1 target as R:R multiple",
  },
  tp2RR: {
    value: 3.0, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "TP2 target as R:R multiple",
  },
  timeoutBars: {
    value: 60, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createLongRangeRetestEmaMacdPartialTp(
  paramOverrides?: Partial<Record<keyof LongRangeRetestEmaMacdPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof LongRangeRetestEmaMacdPartialTpParams];
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

  function find4hEma(currentT: number, htfRef: Candle[], htfEma: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT && !isNaN(htfEma[j])) {
        return htfEma[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Long Range Retest EMA MACD Partial-TP",
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

      const atr15mVal = atr15mCache ? atr15mCache[index] : NaN;
      if (isNaN(atr15mVal) || atr15mVal <= 0) return null;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1h)) return null;

      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < EMA_PERIOD + 1) return null;
      const ema4h = htf4hEmaCache ?? ema(htf4hRef.map(c => c.c), EMA_PERIOD);
      const ema4hVal = find4hEma(currentCandle.t, htf4hRef, ema4h);
      if (isNaN(ema4hVal)) return null;

      const macdHist = macdHistCache ? macdHistCache[index] : NaN;

      const volSma = volSmaCache ? volSmaCache[index] : NaN;
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volSma) ? volMult * volSma : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const retestWin = Math.round(params.retestWindow.value);

      ctx.indicator("atr15m", atr15mVal);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("ema4h", ema4hVal);
      ctx.indicator("macdHist", macdHist);
      ctx.indicator("volSma20", volSma);

      // === PHASE 2: Check pending retest for long entry ===
      if (pendingRetest) {
        const barsSinceBreakout = index - pendingRetest.breakoutBar;
        ctx.indicator("retestBarsWaiting", barsSinceBreakout);

        if (barsSinceBreakout > retestWin) {
          pendingRetest = null;
        } else {
          const level = pendingRetest.level;
          const atr1hBk = pendingRetest.atr1hAtBreakout;
          const stopDist = atr1hBk * stopMult;
          const risk = stopDist;
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
              comment: "Range retest long (EMA+MACD)",
            };
          }

          if (close < level - atr1hBk) {
            pendingRetest = null;
          } else {
            return null;
          }
        }
      }

      // === PHASE 1: Detect long breakout (sets pending retest) ===
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

      const longConsolidation = ctx.track("L:consolidated", isConsolidated, normalizedWidth, threshold);
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longRegime = ctx.track("L:above_ema4h", close > ema4hVal, close, ema4hVal);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longConsolidation && longBreakout && longRegime && longVol) {
        pendingRetest = {
          level: rangeHigh,
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

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const trailDist = ATR_TRAIL_MULT * atr1hVal;

      let highestHigh = positionEntryPrice;
      for (let k = positionEntryBarIndex; k <= index; k++) {
        if (candles[k].h > highestHigh) highestHigh = candles[k].h;
      }
      const trailStop = highestHigh - trailDist;
      ctx.indicator("trailStop", trailStop);
      if (currentCandle.c < trailStop) {
        return { exit: true, comment: "ATR Trail" };
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

      const trailDist = ATR_TRAIL_MULT * atr1hVal;

      let highestHigh = positionEntryPrice;
      for (let k = positionEntryBarIndex; k <= index; k++) {
        if (candles[k].h > highestHigh) highestHigh = candles[k].h;
      }
      return highestHigh - trailDist;
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
