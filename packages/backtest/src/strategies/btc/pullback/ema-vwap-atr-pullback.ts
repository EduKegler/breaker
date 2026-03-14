import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { atr } from "../../../indicators/atr.js";
import { adx as computeAdx } from "../../../indicators/adx.js";
import { slope } from "../../../indicators/slope.js";

// Fixed constants
const ATR_PERIOD = 14;
const MS_1H = 3_600_000;
const TP1_PCT = 0.50; // 50% closed at TP1
const STRENGTH_THRESHOLD = 0.67; // Close must be in upper/lower third of candle
const DEAD_MARKET_PCT = 0.001; // ATR must be > 0.1% of price
const MAX_HOLD_BARS = 96; // 24h hard timeout to prevent funding bleed
const SLOPE_LOOKBACK = 5; // 1H bars for slope calculation

interface EmaVwapAtrPullbackParams {
  emaFast: StrategyParam;
  emaSlow: StrategyParam;
  vwapPeriod: StrategyParam;
  atrStopMult: StrategyParam;
  tp1RR: StrategyParam;
  timeoutBars: StrategyParam;
  // Optional filters (set to 0 to disable)
  adxThreshold: StrategyParam;
  slopeThreshold: StrategyParam;
  pullbackBars: StrategyParam;
}

const DEFAULT_PARAMS: EmaVwapAtrPullbackParams = {
  emaFast: {
    value: 20, min: 8, max: 20, step: 2, optimizable: true,
    description: "Fast EMA period for trend and pullback zone",
  },
  emaSlow: {
    value: 60, min: 40, max: 80, step: 10, optimizable: true,
    description: "Slow EMA period for trend direction",
  },
  vwapPeriod: {
    value: 96, min: 48, max: 192, step: 24, optimizable: true,
    description: "Rolling VWAP period in bars (96 = 1 day of 15m)",
  },
  atrStopMult: {
    value: 1.5, min: 1.0, max: 2.5, step: 0.25, optimizable: true,
    description: "ATR(14) 1H multiplier for stop and ATR trailing",
  },
  tp1RR: {
    value: 1.0, min: 0.75, max: 2.0, step: 0.25, optimizable: true,
    description: "TP1 target as R:R multiple (closes 50% of position)",
  },
  timeoutBars: {
    value: 10, min: 6, max: 16, step: 2, optimizable: true,
    description: "Exit at-loss trades after N bars (no follow-through)",
  },
  adxThreshold: {
    value: 0, min: 0, max: 35, step: 1, optimizable: true,
    description: "1H ADX(14) minimum for trending regime (0 = disabled)",
  },
  slopeThreshold: {
    value: 0, min: 0, max: 1.0, step: 0.1, optimizable: true,
    description: "EMA(slow) slope / ATR minimum for trend quality (0 = disabled)",
  },
  pullbackBars: {
    value: 1, min: 1, max: 4, step: 1, optimizable: true,
    description: "Minimum bars in pullback zone before trigger (1 = single-bar, 2+ = multi-bar)",
  },
};

export function createEmaVwapAtrPullback(
  paramOverrides?: Partial<Record<keyof EmaVwapAtrPullbackParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof EmaVwapAtrPullbackParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let emaFastCache: number[] = [];
  let emaSlowCache: number[] = [];
  let atr15mCache: number[] = [];
  let rollingVwapCache: number[] = [];
  let htf1hCandles: Candle[] = [];
  let htfAtrCache1h: number[] = [];
  let htfAdxCache1h: number[] = [];
  // EMA slope on 1H: slope of emaSlow equivalent, normalized by ATR
  let htfEmaSlopeNorm: number[] = [];

  /** O(n) rolling VWAP via sliding window — no session reset. */
  function computeRollingVwap(candles: Candle[], period: number): number[] {
    const len = candles.length;
    const result = new Array<number>(len).fill(NaN);
    let sumTPV = 0;
    let sumV = 0;

    for (let i = 0; i < len; i++) {
      const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
      sumTPV += tp * candles[i].v;
      sumV += candles[i].v;

      if (i >= period) {
        const oldTp = (candles[i - period].h + candles[i - period].l + candles[i - period].c) / 3;
        sumTPV -= oldTp * candles[i - period].v;
        sumV -= candles[i - period].v;
      }

      result[i] = sumV > 0 ? sumTPV / sumV : NaN;
    }

    return result;
  }

  /** Find completed 1H indicator value (anti-repaint). */
  function findHtfValue(currentT: number, values: number[]): number {
    for (let j = htf1hCandles.length - 1; j >= 0; j--) {
      if (htf1hCandles[j].t + MS_1H <= currentT && !isNaN(values[j])) {
        return values[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Pullback — EMA VWAP ATR",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 80, "1h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes = candles.map(c => c.c);
      emaFastCache = ema(closes, Math.round(params.emaFast.value));
      emaSlowCache = ema(closes, Math.round(params.emaSlow.value));
      atr15mCache = atr(candles, ATR_PERIOD);
      rollingVwapCache = computeRollingVwap(candles, Math.round(params.vwapPeriod.value));

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache1h = atr(htf1hCandles, ATR_PERIOD);
        htfAdxCache1h = computeAdx(htf1hCandles, ATR_PERIOD).adx;

        // Compute EMA slope on 1H, normalized by ATR
        // Use emaSlow/4 as equivalent period on 1H (60 on 15m ≈ 15 on 1H)
        const htfCloses = htf1hCandles.map(c => c.c);
        const htfEmaPeriod = Math.max(5, Math.round(params.emaSlow.value / 4));
        const htfEmaArr = ema(htfCloses, htfEmaPeriod);
        const htfSlopeRaw = slope(htfEmaArr, SLOPE_LOOKBACK);

        htfEmaSlopeNorm = htfSlopeRaw.map((s, i) => {
          const a = htfAtrCache1h[i];
          if (isNaN(s) || isNaN(a) || a === 0) return NaN;
          return s / a;
        });
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle } = ctx;
      const slowPeriod = Math.round(params.emaSlow.value);
      if (index < slowPeriod + ATR_PERIOD) return null;
      if (ctx.positionDirection) return null;

      const close = currentCandle.c;
      const high = currentCandle.h;
      const low = currentCandle.l;
      const range = high - low;

      const emaFastVal = emaFastCache[index];
      const emaSlowVal = emaSlowCache[index];
      const atr15mVal = atr15mCache[index];
      const vwapVal = rollingVwapCache[index];

      if (isNaN(emaFastVal) || isNaN(emaSlowVal) || isNaN(atr15mVal) || isNaN(vwapVal)) return null;
      if (range <= 0) return null;

      // Dead market filter
      if (atr15mVal < DEAD_MARKET_PCT * close) return null;

      // 1H ATR for stop distance
      const atr1hVal = findHtfValue(currentCandle.t, htfAtrCache1h);
      if (isNaN(atr1hVal)) return null;

      // --- Optional filters ---
      const adxThresh = params.adxThreshold.value;
      const slopeThresh = params.slopeThreshold.value;
      const minPullbackBars = Math.round(params.pullbackBars.value);

      // ADX filter (1H)
      let adx1hVal = NaN;
      if (adxThresh > 0) {
        adx1hVal = findHtfValue(currentCandle.t, htfAdxCache1h);
      }

      // EMA slope filter (1H, normalized by ATR)
      let slopeNormVal = NaN;
      if (slopeThresh > 0) {
        slopeNormVal = findHtfValue(currentCandle.t, htfEmaSlopeNorm);
      }

      ctx.indicator("emaFast", emaFastVal);
      ctx.indicator("emaSlow", emaSlowVal);
      ctx.indicator("atr15m", atr15mVal);
      ctx.indicator("atr1h", atr1hVal);
      ctx.indicator("rollingVwap", vwapVal);
      if (!isNaN(adx1hVal)) ctx.indicator("adx1h", adx1hVal);
      if (!isNaN(slopeNormVal)) ctx.indicator("slopeNorm1h", slopeNormVal);

      const stopMult = params.atrStopMult.value;
      const tp1RR = params.tp1RR.value;

      // ==========================================================
      // LONG: EMA(fast) > EMA(slow), price > VWAP, pullback to EMA
      // ==========================================================
      const longTrend = ctx.track("L:ema_trend", emaFastVal > emaSlowVal, emaFastVal, emaSlowVal);
      const longVwap = ctx.track("L:above_vwap", close > vwapVal, close, vwapVal);
      const longPullback = ctx.track("L:pullback_touch", low <= emaFastVal, low, emaFastVal);
      const longHold = ctx.track("L:close_above_ema", close > emaFastVal, close, emaFastVal);
      const longStrength = ctx.track("L:bullish_close",
        close > low + STRENGTH_THRESHOLD * range, close, low + STRENGTH_THRESHOLD * range);

      // Optional: ADX regime gate
      const longAdx = adxThresh > 0
        ? ctx.track("L:adx_trending", !isNaN(adx1hVal) && adx1hVal > adxThresh, adx1hVal, adxThresh)
        : true;

      // Optional: EMA slope quality gate
      const longSlope = slopeThresh > 0
        ? ctx.track("L:slope_positive", !isNaN(slopeNormVal) && slopeNormVal > slopeThresh, slopeNormVal, slopeThresh)
        : true;

      // Optional: Multi-bar pullback confirmation
      let longMultiBar = true;
      if (minPullbackBars >= 2) {
        // Count previous bars where close was below emaFast (genuine pullback dip)
        let pullbackCount = 0;
        const lookWindow = Math.min(minPullbackBars + 2, index); // check recent bars
        for (let k = 1; k <= lookWindow; k++) {
          const prevIdx = index - k;
          if (prevIdx < 0) break;
          if (candles[prevIdx].c < emaFastCache[prevIdx]) pullbackCount++;
        }
        longMultiBar = ctx.track("L:multi_bar_pb", pullbackCount >= minPullbackBars - 1, pullbackCount, minPullbackBars - 1);
      }

      if (longTrend && longVwap && longPullback && longHold && longStrength && longAdx && longSlope && longMultiBar) {
        const stopDist = stopMult * atr1hVal;
        const pullbackStop = low - 0.1 * atr1hVal;
        const atrStop = close - stopDist;
        const stopLoss = Math.min(atrStop, pullbackStop);
        const actualStopDist = close - stopLoss;
        const tp1Price = close + actualStopDist * tp1RR;

        return {
          direction: "long",
          entryPrice: null,
          stopLoss,
          takeProfits: [{ price: tp1Price, pctOfPosition: TP1_PCT }],
          comment: "EMA pullback long (VWAP confirmed)",
        };
      }

      // ==========================================================
      // SHORT: EMA(fast) < EMA(slow), price < VWAP, pullback to EMA
      // ==========================================================
      const shortTrend = ctx.track("S:ema_trend", emaFastVal < emaSlowVal, emaFastVal, emaSlowVal);
      const shortVwap = ctx.track("S:below_vwap", close < vwapVal, close, vwapVal);
      const shortPullback = ctx.track("S:pullback_touch", high >= emaFastVal, high, emaFastVal);
      const shortHold = ctx.track("S:close_below_ema", close < emaFastVal, close, emaFastVal);
      const shortStrength = ctx.track("S:bearish_close",
        close < high - STRENGTH_THRESHOLD * range, close, high - STRENGTH_THRESHOLD * range);

      // Optional: ADX regime gate
      const shortAdx = adxThresh > 0
        ? ctx.track("S:adx_trending", !isNaN(adx1hVal) && adx1hVal > adxThresh, adx1hVal, adxThresh)
        : true;

      // Optional: EMA slope quality gate (negative slope for shorts)
      const shortSlope = slopeThresh > 0
        ? ctx.track("S:slope_negative", !isNaN(slopeNormVal) && slopeNormVal < -slopeThresh, slopeNormVal, -slopeThresh)
        : true;

      // Optional: Multi-bar pullback confirmation
      let shortMultiBar = true;
      if (minPullbackBars >= 2) {
        let pullbackCount = 0;
        const lookWindow = Math.min(minPullbackBars + 2, index);
        for (let k = 1; k <= lookWindow; k++) {
          const prevIdx = index - k;
          if (prevIdx < 0) break;
          if (candles[prevIdx].c > emaFastCache[prevIdx]) pullbackCount++;
        }
        shortMultiBar = ctx.track("S:multi_bar_pb", pullbackCount >= minPullbackBars - 1, pullbackCount, minPullbackBars - 1);
      }

      if (shortTrend && shortVwap && shortPullback && shortHold && shortStrength && shortAdx && shortSlope && shortMultiBar) {
        const stopDist = stopMult * atr1hVal;
        const pullbackStop = high + 0.1 * atr1hVal;
        const atrStop = close + stopDist;
        const stopLoss = Math.max(atrStop, pullbackStop);
        const actualStopDist = stopLoss - close;
        const tp1Price = close - actualStopDist * tp1RR;

        return {
          direction: "short",
          entryPrice: null,
          stopLoss,
          takeProfits: [{ price: tp1Price, pctOfPosition: TP1_PCT }],
          comment: "EMA pullback short (VWAP confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null || ctx.positionEntryPrice === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      const close = ctx.currentCandle.c;

      // Hard timeout: no trade should exceed 24h (funding costs)
      if (barsInTrade >= MAX_HOLD_BARS) {
        return { exit: true, comment: "Max hold timeout" };
      }

      // Conditional time-stop: exit at-loss trades after N bars
      const timeoutBars = Math.round(params.timeoutBars.value);
      const isLosing = ctx.positionDirection === "long"
        ? close <= ctx.positionEntryPrice
        : close >= ctx.positionEntryPrice;

      if (barsInTrade >= timeoutBars && isLosing) {
        return { exit: true, comment: "Timeout (no follow-through)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection, positionEntryPrice, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      const atr1hVal = findHtfValue(ctx.currentCandle.t, htfAtrCache1h);
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
      const atr1hVal = findHtfValue(ctx.currentCandle.t, htfAtrCache1h);
      if (isNaN(atr1hVal)) return null;

      const { c: close, l: low, h: high } = ctx.currentCandle;
      const stopMult = params.atrStopMult.value;

      if (direction === "long") {
        const atrStop = close - stopMult * atr1hVal;
        const pullbackStop = low - 0.1 * atr1hVal;
        const stopLoss = Math.min(atrStop, pullbackStop);
        const actualStopDist = close - stopLoss;
        return {
          stopLoss,
          takeProfits: [{ price: close + actualStopDist * params.tp1RR.value, pctOfPosition: TP1_PCT }],
        };
      } else {
        const atrStop = close + stopMult * atr1hVal;
        const pullbackStop = high + 0.1 * atr1hVal;
        const stopLoss = Math.max(atrStop, pullbackStop);
        const actualStopDist = stopLoss - close;
        return {
          stopLoss,
          takeProfits: [{ price: close - actualStopDist * params.tp1RR.value, pctOfPosition: TP1_PCT }],
        };
      }
    },
  };
}
