import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

interface RangeEmaAtrTrailParams {
  rangeLookback: StrategyParam;
  rangeAtrThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeEmaAtrTrailParams = {
  rangeLookback: {
    value: 15, min: 10, max: 40, step: 5, optimizable: true,
    description: "Bars to look back for range high/low definition",
  },
  rangeAtrThreshold: {
    value: 3.0, min: 1.5, max: 6.0, step: 0.5, optimizable: true,
    description: "Max range width as multiple of ATR(14) 15m — below = consolidation",
  },
  volMultiplier: {
    value: 3, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 4.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  atrTrailMult: {
    value: 4.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier for exit",
  },
  timeoutBars: {
    value: 60, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createRangeEmaAtrTrail(
  paramOverrides?: Partial<Record<keyof RangeEmaAtrTrailParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeEmaAtrTrailParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htfDailyCandles: Candle[] | null = null;
  let htfDailyEmaCache: number[] | null = null;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function findDailyEma(currentT: number, dailyRef: Candle[], dailyEma: number[]): number {
    for (let j = dailyRef.length - 1; j >= 0; j--) {
      if (dailyRef[j].t + MS_1D <= currentT && !isNaN(dailyEma[j])) {
        return dailyEma[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Range EMA ATR-Trail",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 50, "1h": 15, "1d": 210 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfDailyCandles = higherTimeframes["1d"] ?? [];
      htfDailyEmaCache = htfDailyCandles.length > 0
        ? ema(htfDailyCandles.map(c => c.c), 200)
        : null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const lookback = Math.round(params.rangeLookback.value);
      if (index < lookback + 14) return null;

      if (ctx.positionDirection) return null;

      // --- ATR(14, 15m) for range normalization ---
      const atr15mVal = atr15mCache ? atr15mCache[index] : NaN;
      if (isNaN(atr15mVal) || atr15mVal <= 0) return null;

      // --- Range detection: high/low of previous lookback bars ---
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

      // --- HTF: 1H ATR for stop (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- Daily EMA(200) regime (anti-repaint) ---
      const dailyRef = htfDailyCandles ?? higherTimeframes["1d"];
      if (!dailyRef || dailyRef.length < 201) return null;
      const dailyEma = htfDailyEmaCache ?? ema(dailyRef.map(c => c.c), 200);
      const ema200 = findDailyEma(currentCandle.t, dailyRef, dailyEma);
      if (isNaN(ema200)) return null;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;

      // --- Diagnostics ---
      ctx.indicator("rangeHigh", rangeHigh);
      ctx.indicator("rangeLow", rangeLow);
      ctx.indicator("rangeWidth", rangeWidth);
      ctx.indicator("normalizedWidth", normalizedWidth);
      ctx.indicator("atr15m", atr15mVal);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("ema200d", ema200);
      ctx.indicator("volAvg20", volAvg20);

      // --- LONG: consolidated range + close above rangeHigh + above EMA(200) + volume spike ---
      const longConsolidation = ctx.track("L:consolidated", isConsolidated, normalizedWidth, threshold);
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longRegime = ctx.track("L:above_ema200", close > ema200, close, ema200);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longConsolidation && longBreakout && longRegime && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Range breakout long (EMA)",
        };
      }

      // --- SHORT: consolidated range + close below rangeLow + below EMA(200) + volume spike ---
      const shortConsolidation = ctx.track("S:consolidated", isConsolidated, normalizedWidth, threshold);
      const shortBreakout = ctx.track("S:close_below_range", close < rangeLow, close, rangeLow);
      const shortRegime = ctx.track("S:below_ema200", close < ema200, close, ema200);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortConsolidation && shortBreakout && shortRegime && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Range breakout short (EMA)",
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

      // ATR trailing stop
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const trailDist = params.atrTrailMult.value * atr1hVal;

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

      const trailDist = params.atrTrailMult.value * atr1hVal;

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

      if (direction === "long") {
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
