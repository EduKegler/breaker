import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { atr } from "../../../indicators/atr.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { rsi } from "../../../indicators/rsi.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

// Fixed non-tunable constants (KB rule 6 — house rules, not optimizable)
const ATR_BUFFER = 0.2;
const STOP_HARD_CAP = 2.5;
const ATR_1H_PERIOD = 14;
const ADX_PERIOD = 14;
const EMA_FAST = 9;   // 9/30 pattern — fixed, not tunable
const WMA_SLOW = 30;  // 9/30 pattern — fixed, not tunable

/** Weighted Moving Average — inline (not in indicator library) */
function wma(values: number[], period: number): number[] {
  const result = new Array<number>(values.length).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let num = 0;
    for (let j = 0; j < period; j++) {
      num += values[i - period + 1 + j] * (j + 1);
    }
    result[i] = num / denom;
  }
  return result;
}

interface AdxHigh930RsiResetAtrTrailParams {
  adxThreshold: StrategyParam;
  rsiPeriod: StrategyParam;
  rsiThreshold: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: AdxHigh930RsiResetAtrTrailParams = {
  adxThreshold: {
    value: 25, min: 15, max: 40, step: 5, optimizable: true,
    description: "ADX(14) 4H minimum for trend strength confirmation",
  },
  rsiPeriod: {
    value: 14, min: 7, max: 21, step: 2, optimizable: true,
    description: "RSI period on 15m for neutral zone reset confirmation",
  },
  rsiThreshold: {
    value: 45, min: 35, max: 55, step: 5, optimizable: true,
    description: "RSI neutral zone threshold (longs: below; shorts: above 100-threshold)",
  },
  atrTrailMult: {
    value: 2.5, min: 1.5, max: 4.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier",
  },
  timeoutBars: {
    value: 32, min: 16, max: 64, step: 4, optimizable: true,
    description: "Timeout exit in 15m bars (32 = 8h)",
  },
};

export function createAdxHigh930RsiResetAtrTrail(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof AdxHigh930RsiResetAtrTrailParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // HTF caches (populated in init)
  let htf4hCandles: Candle[] = [];
  let htf1hCandles: Candle[] = [];
  let htf4hAdxCache: AdxResult | null = null;
  let htf1hAtrCache: number[] | null = null;

  // 15m indicator caches
  let ema9Cache: number[] | null = null;
  let wma30Cache: number[] | null = null;
  let rsiCache: number[] | null = null;

  // Pullback zone tracking state
  let inPullbackZone = false;
  let pullbackDirection: "long" | "short" | null = null;
  let pullbackLow = Infinity;
  let pullbackHigh = -Infinity;

  function resetPullback(): void {
    inPullbackZone = false;
    pullbackDirection = null;
    pullbackLow = Infinity;
    pullbackHigh = -Infinity;
  }

  // Anti-repaint HTF lookups: only use last fully CLOSED candle
  function findHtf4hAdx(currentT: number): number {
    if (!htf4hAdxCache) return NaN;
    for (let j = htf4hCandles.length - 1; j >= 0; j--) {
      if (htf4hCandles[j].t + MS_4H <= currentT && !isNaN(htf4hAdxCache.adx[j])) {
        return htf4hAdxCache.adx[j];
      }
    }
    return NaN;
  }

  function findHtf4hDiPlus(currentT: number): number {
    if (!htf4hAdxCache) return NaN;
    for (let j = htf4hCandles.length - 1; j >= 0; j--) {
      if (htf4hCandles[j].t + MS_4H <= currentT && !isNaN(htf4hAdxCache.diPlus[j])) {
        return htf4hAdxCache.diPlus[j];
      }
    }
    return NaN;
  }

  function findHtf4hDiMinus(currentT: number): number {
    if (!htf4hAdxCache) return NaN;
    for (let j = htf4hCandles.length - 1; j >= 0; j--) {
      if (htf4hCandles[j].t + MS_4H <= currentT && !isNaN(htf4hAdxCache.diMinus[j])) {
        return htf4hAdxCache.diMinus[j];
      }
    }
    return NaN;
  }

  function findHtf1hAtr(currentT: number): number {
    if (!htf1hAtrCache) return NaN;
    for (let j = htf1hCandles.length - 1; j >= 0; j--) {
      if (htf1hCandles[j].t + MS_1H <= currentT && !isNaN(htf1hAtrCache[j])) {
        return htf1hAtrCache[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Pullback — ADX High 930 RSI Reset ATR Trail",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hAdxCache = htf4hCandles.length > 0 ? adxIndicator(htf4hCandles, ADX_PERIOD) : null;
      htf1hAtrCache = htf1hCandles.length > 0 ? atr(htf1hCandles, ATR_1H_PERIOD) : null;

      // 15m indicator caches
      const closes = candles.map(c => c.c);
      ema9Cache = ema(closes, EMA_FAST);
      wma30Cache = wma(closes, WMA_SLOW);
      rsiCache = rsi(closes, params.rsiPeriod.value);

      resetPullback();
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle } = ctx;
      if (index < WMA_SLOW + 5) return null;

      // --- HTF values (anti-repaint: last CLOSED candle only) ---
      const adx4h = findHtf4hAdx(currentCandle.t);
      const diPlus4h = findHtf4hDiPlus(currentCandle.t);
      const diMinus4h = findHtf4hDiMinus(currentCandle.t);
      const atr1h = findHtf1hAtr(currentCandle.t);
      if (isNaN(adx4h) || isNaN(diPlus4h) || isNaN(diMinus4h) || isNaN(atr1h) || atr1h <= 0) return null;

      // --- 15m indicators ---
      if (!ema9Cache || !wma30Cache || !rsiCache) return null;
      const ema9 = ema9Cache[index];
      const wma30val = wma30Cache[index];
      const rsiVal = rsiCache[index];
      if (isNaN(ema9) || isNaN(wma30val) || isNaN(rsiVal)) return null;

      const close = currentCandle.c;
      const adxThresh = params.adxThreshold.value;
      const rsiThresh = params.rsiThreshold.value;

      // Diagnostics
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("diPlus4h", diPlus4h);
      ctx.indicator("diMinus4h", diMinus4h);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("ema9", ema9);
      ctx.indicator("wma30", wma30val);
      ctx.indicator("rsi", rsiVal);

      // --- 9/30 zone structure ---
      const longZone = ema9 > wma30val;  // 15m uptrend structure
      const shortZone = ema9 < wma30val; // 15m downtrend structure
      const zoneWidth = Math.abs(ema9 - wma30val);

      // --- Pullback zone state machine ---

      // Reset if structure flipped or price too far from zone
      if (inPullbackZone) {
        if (pullbackDirection === "long" && !longZone) {
          resetPullback();
        } else if (pullbackDirection === "short" && !shortZone) {
          resetPullback();
        } else if (pullbackDirection === "long" && close < wma30val - zoneWidth) {
          resetPullback(); // Dropped too far below zone — reversal
        } else if (pullbackDirection === "short" && close > wma30val + zoneWidth) {
          resetPullback(); // Rallied too far above zone — reversal
        }
      }

      // Enter pullback zone (price between EMA9 and WMA30)
      const priceInLongZone = longZone && close >= wma30val && close <= ema9;
      const priceInShortZone = shortZone && close <= wma30val && close >= ema9;

      if (!inPullbackZone) {
        if (priceInLongZone) {
          inPullbackZone = true;
          pullbackDirection = "long";
          pullbackLow = currentCandle.l;
          pullbackHigh = currentCandle.h;
          return null; // Need at least 1 bar of tracking before confirmation
        }
        if (priceInShortZone) {
          inPullbackZone = true;
          pullbackDirection = "short";
          pullbackLow = currentCandle.l;
          pullbackHigh = currentCandle.h;
          return null;
        }
        return null;
      }

      // --- Check LONG confirmation ---
      if (inPullbackZone && pullbackDirection === "long") {
        // 4H ADX trend strength
        const adxOk = ctx.track("L:adx_high", adx4h >= adxThresh, adx4h, adxThresh);
        // 4H DI+ > DI- (long direction on HTF)
        const diOk = ctx.track("L:di_long", diPlus4h > diMinus4h, diPlus4h, diMinus4h);
        // RSI in neutral zone (momentum reset)
        const rsiOk = ctx.track("L:rsi_neutral", rsiVal < rsiThresh, rsiVal, rsiThresh);

        if (adxOk && diOk && rsiOk) {
          const stopPrice = pullbackLow - ATR_BUFFER * atr1h;
          const stopDist = close - stopPrice;
          const withinCap = ctx.track("L:stop_within_cap", stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
          const validStop = ctx.track("L:stop_positive", stopDist > 0, stopDist, 0);

          if (withinCap && validStop) {
            const signal: Signal = {
              direction: "long",
              entryPrice: null,
              stopLoss: stopPrice,
              takeProfits: [], // ATR trailing exit — no fixed TP
              comment: `Pullback long: ADX=${adx4h.toFixed(0)} RSI=${rsiVal.toFixed(0)}`,
            };
            resetPullback();
            return signal;
          }
          resetPullback();
          return null;
        }

        // Update extremes while still near zone
        pullbackLow = Math.min(pullbackLow, currentCandle.l);
        pullbackHigh = Math.max(pullbackHigh, currentCandle.h);

        // Reset if price bounced too far above zone without confirmation
        if (close > ema9 + zoneWidth) {
          resetPullback();
        }
        return null;
      }

      // --- Check SHORT confirmation ---
      if (inPullbackZone && pullbackDirection === "short") {
        // 4H ADX trend strength
        const adxOk = ctx.track("S:adx_high", adx4h >= adxThresh, adx4h, adxThresh);
        // 4H DI- > DI+ (short direction on HTF)
        const diOk = ctx.track("S:di_short", diMinus4h > diPlus4h, diMinus4h, diPlus4h);
        // RSI overbought reset for shorts (100 - threshold)
        const rsiShortThresh = 100 - rsiThresh;
        const rsiOk = ctx.track("S:rsi_neutral", rsiVal > rsiShortThresh, rsiVal, rsiShortThresh);

        if (adxOk && diOk && rsiOk) {
          const stopPrice = pullbackHigh + ATR_BUFFER * atr1h;
          const stopDist = stopPrice - close;
          const withinCap = ctx.track("S:stop_within_cap", stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
          const validStop = ctx.track("S:stop_positive", stopDist > 0, stopDist, 0);

          if (withinCap && validStop) {
            const signal: Signal = {
              direction: "short",
              entryPrice: null,
              stopLoss: stopPrice,
              takeProfits: [],
              comment: `Pullback short: ADX=${adx4h.toFixed(0)} RSI=${rsiVal.toFixed(0)}`,
            };
            resetPullback();
            return signal;
          }
          resetPullback();
          return null;
        }

        pullbackLow = Math.min(pullbackLow, currentCandle.l);
        pullbackHigh = Math.max(pullbackHigh, currentCandle.h);

        if (close < ema9 - zoneWidth) {
          resetPullback();
        }
        return null;
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      // Timeout first (mandatory — Rule 7)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // ATR trailing stop
      const atr1h = findHtf1hAtr(currentCandle.t);
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
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      const atr1h = findHtf1hAtr(currentCandle.t);
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
      const { currentCandle } = ctx;

      const atr1h = findHtf1hAtr(currentCandle.t);
      if (isNaN(atr1h)) return null;

      const close = currentCandle.c;
      const buffer = ATR_BUFFER * atr1h;

      if (direction === "long") {
        const stopPrice = currentCandle.l - buffer;
        const stopDist = close - stopPrice;
        if (stopDist > STOP_HARD_CAP * atr1h || stopDist <= 0) return null;
        return { stopLoss: stopPrice, takeProfits: [] };
      } else {
        const stopPrice = currentCandle.h + buffer;
        const stopDist = stopPrice - close;
        if (stopDist > STOP_HARD_CAP * atr1h || stopDist <= 0) return null;
        return { stopLoss: stopPrice, takeProfits: [] };
      }
    },
  };
}
