import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

// Fixed non-tunable constants (KB rule 6 — house rules, not optimizable)
const ATR_BUFFER = 0.2;
const STOP_HARD_CAP = 2.5;
const ATR_1H_PERIOD = 14;
const VOL_SMA_PERIOD = 20;
const MIN_RR = 1.0;
const STALE_BARS = 20;

interface EmaEmaSupportVolumeFibExtParams {
  emaTrendPeriod: StrategyParam;
  emaSupportPeriod: StrategyParam;
  pullbackDepth: StrategyParam;
  volMult: StrategyParam;
  fibExtLevel: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: EmaEmaSupportVolumeFibExtParams = {
  emaTrendPeriod: {
    value: 21, min: 13, max: 34, step: 3, optimizable: true,
    description: "EMA period on 4H for trend direction confirmation",
  },
  emaSupportPeriod: {
    value: 21, min: 13, max: 50, step: 3, optimizable: true,
    description: "EMA period on 15m for pullback support zone",
  },
  pullbackDepth: {
    value: 1.5, min: 0.5, max: 3.0, step: 0.25, optimizable: true,
    description: "ATR(14,1H)-normalized max distance from 15m EMA to enter zone",
  },
  volMult: {
    value: 1.2, min: 1.0, max: 2.0, step: 0.1, optimizable: true,
    description: "Volume expansion threshold (bar vol > volMult x SMA20 vol)",
  },
  fibExtLevel: {
    value: 1.272, min: 1.100, max: 1.618, step: 0.050, optimizable: true,
    description: "Fibonacci extension level for TP target",
  },
  timeoutBars: {
    value: 32, min: 16, max: 64, step: 4, optimizable: true,
    description: "Timeout exit in 15m bars (32 = 8h)",
  },
};

export function createEmaEmaSupportVolumeFibExt(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // HTF caches
  let htf4hCandles: Candle[] = [];
  let htf1hCandles: Candle[] = [];
  let htf4hEmaCache: number[] | null = null;
  let htf1hAtrCache: number[] | null = null;

  // 15m caches
  let ema15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;

  // Pullback tracking state
  let inPullbackZone = false;
  let pullbackDirection: "long" | "short" | null = null;
  let pullbackLow = Infinity;
  let pullbackHigh = -Infinity;
  let priorSwingHigh = -Infinity;
  let priorSwingLow = Infinity;
  let pullbackEntryIndex = -1;

  function resetPullback(): void {
    inPullbackZone = false;
    pullbackDirection = null;
    pullbackLow = Infinity;
    pullbackHigh = -Infinity;
    priorSwingHigh = -Infinity;
    priorSwingLow = Infinity;
    pullbackEntryIndex = -1;
  }

  function findHtf4hEma(currentT: number): { value: number; prevValue: number } | null {
    if (!htf4hEmaCache) return null;
    let found = 0;
    let current = NaN;
    let prev = NaN;
    for (let j = htf4hCandles.length - 1; j >= 0; j--) {
      if (htf4hCandles[j].t + MS_4H <= currentT && !isNaN(htf4hEmaCache[j])) {
        if (found === 0) {
          current = htf4hEmaCache[j];
          found++;
        } else {
          prev = htf4hEmaCache[j];
          found++;
          break;
        }
      }
    }
    if (found < 2) return null;
    return { value: current, prevValue: prev };
  }

  function findHtf4hClose(currentT: number): number {
    for (let j = htf4hCandles.length - 1; j >= 0; j--) {
      if (htf4hCandles[j].t + MS_4H <= currentT) {
        return htf4hCandles[j].c;
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

  function findPriorHigh(candles: Candle[], index: number, lookback: number): number {
    let highest = -Infinity;
    for (let i = Math.max(0, index - lookback); i < index; i++) {
      highest = Math.max(highest, candles[i].h);
    }
    return highest;
  }

  function findPriorLow(candles: Candle[], index: number, lookback: number): number {
    let lowest = Infinity;
    for (let i = Math.max(0, index - lookback); i < index; i++) {
      lowest = Math.min(lowest, candles[i].l);
    }
    return lowest;
  }

  return {
    name: "BTC 15m Pullback — EMA EMA Support Volume Fib Ext",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 60, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htf1hCandles = higherTimeframes["1h"] ?? [];

      if (htf4hCandles.length > 0) {
        htf4hEmaCache = ema(htf4hCandles.map(c => c.c), params.emaTrendPeriod.value);
      } else {
        htf4hEmaCache = null;
      }

      htf1hAtrCache = htf1hCandles.length > 0
        ? atr(htf1hCandles, ATR_1H_PERIOD)
        : null;

      ema15mCache = ema(candles.map(c => c.c), params.emaSupportPeriod.value);
      volSmaCache = sma(candles.map(c => c.v), VOL_SMA_PERIOD);

      resetPullback();
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle } = ctx;
      const warmup = Math.max(params.emaSupportPeriod.value, VOL_SMA_PERIOD) + 5;
      if (index < warmup) return null;

      // --- HTF values (anti-repaint: last CLOSED candle only) ---
      const htfEma = findHtf4hEma(currentCandle.t);
      const htf4hClose = findHtf4hClose(currentCandle.t);
      const atr1h = findHtf1hAtr(currentCandle.t);
      if (!htfEma || isNaN(htf4hClose) || isNaN(atr1h) || atr1h <= 0) return null;

      // --- 15m indicators ---
      if (!ema15mCache || !volSmaCache) return null;
      const ema15m = ema15mCache[index];
      const volAvg = volSmaCache[index];
      if (isNaN(ema15m) || isNaN(volAvg) || volAvg <= 0) return null;

      const close = currentCandle.c;
      const { value: ema4h, prevValue: ema4hPrev } = htfEma;
      const pullbackDepthVal = params.pullbackDepth.value;
      const volMultVal = params.volMult.value;
      const fibExtLevelVal = params.fibExtLevel.value;

      // --- 4H EMA trend direction ---
      const isUptrend = htf4hClose > ema4h && ema4h > ema4hPrev;
      const isDowntrend = htf4hClose < ema4h && ema4h < ema4hPrev;

      // Diagnostics
      ctx.indicator("ema4h", ema4h);
      ctx.indicator("htf4hClose", htf4hClose);
      ctx.indicator("ema15m", ema15m);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("volRatio", currentCandle.v / volAvg);

      const emaZoneWidth = pullbackDepthVal * atr1h;

      // --- Invalidate stale pullback ---
      if (inPullbackZone) {
        const trendLost =
          (pullbackDirection === "long" && !isUptrend) ||
          (pullbackDirection === "short" && !isDowntrend);
        const stale = index - pullbackEntryIndex > STALE_BARS;
        if (trendLost || stale) resetPullback();
      }

      // ============= LONG (uptrend pullback to EMA support) =============
      if (isUptrend) {
        // Zone: price near or below 15m EMA (pulling back in uptrend)
        const inLongZone = close >= ema15m - emaZoneWidth && close <= ema15m + emaZoneWidth * 0.3;

        if (!inPullbackZone && inLongZone) {
          const entered = ctx.track("L:enter_ema_zone", true, close - ema15m, emaZoneWidth);
          if (entered) {
            inPullbackZone = true;
            pullbackDirection = "long";
            pullbackLow = currentCandle.l;
            pullbackHigh = currentCandle.h;
            pullbackEntryIndex = index;
            priorSwingHigh = findPriorHigh(candles, index, params.emaSupportPeriod.value * 3);
            return null; // Need at least 1 bar before confirmation
          }
        }

        if (inPullbackZone && pullbackDirection === "long") {
          pullbackLow = Math.min(pullbackLow, currentCandle.l);
          pullbackHigh = Math.max(pullbackHigh, currentCandle.h);

          // Volume expansion on bullish bar = trend resumption confirmation
          const volExpansion = currentCandle.v > volMultVal * volAvg;
          const bullishBar = currentCandle.c > currentCandle.o;
          const confirmed = ctx.track("L:vol_confirm", volExpansion && bullishBar,
            currentCandle.v / volAvg, volMultVal);

          if (confirmed) {
            // Stop at pullback structural low + buffer (KB rule 6)
            const stopPrice = pullbackLow - ATR_BUFFER * atr1h;
            const stopDist = close - stopPrice;

            const withinCap = ctx.track("L:stop_within_cap",
              stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
            const validStop = ctx.track("L:stop_positive", stopDist > 0, stopDist, 0);

            if (withinCap && validStop) {
              // Fib extension: project from pullbackLow through priorSwingHigh
              const moveRange = priorSwingHigh - pullbackLow;
              if (moveRange <= 0) {
                resetPullback();
                return null;
              }
              const tpPrice = pullbackLow + fibExtLevelVal * moveRange;
              const tpDist = tpPrice - close;
              const rr = tpDist / stopDist;
              const rrOk = ctx.track("L:rr_filter", rr >= MIN_RR, rr, MIN_RR);

              if (rrOk) {
                resetPullback();
                return {
                  direction: "long",
                  entryPrice: null,
                  stopLoss: stopPrice,
                  takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
                  comment: `Pullback long: vol=${(currentCandle.v / volAvg).toFixed(1)}x EMA-zone`,
                };
              }
            }
            resetPullback();
            return null;
          }

          // Bounced above zone without confirmation — pullback over
          if (close > ema15m + emaZoneWidth) {
            resetPullback();
          }
          return null;
        }
      }

      // ============= SHORT (downtrend pullback to EMA resistance) =============
      if (isDowntrend) {
        // Zone: price near or above 15m EMA (pulling back in downtrend)
        const inShortZone = close <= ema15m + emaZoneWidth && close >= ema15m - emaZoneWidth * 0.3;

        if (!inPullbackZone && inShortZone) {
          const entered = ctx.track("S:enter_ema_zone", true, ema15m - close, emaZoneWidth);
          if (entered) {
            inPullbackZone = true;
            pullbackDirection = "short";
            pullbackLow = currentCandle.l;
            pullbackHigh = currentCandle.h;
            pullbackEntryIndex = index;
            priorSwingLow = findPriorLow(candles, index, params.emaSupportPeriod.value * 3);
            return null;
          }
        }

        if (inPullbackZone && pullbackDirection === "short") {
          pullbackLow = Math.min(pullbackLow, currentCandle.l);
          pullbackHigh = Math.max(pullbackHigh, currentCandle.h);

          const volExpansion = currentCandle.v > volMultVal * volAvg;
          const bearishBar = currentCandle.c < currentCandle.o;
          const confirmed = ctx.track("S:vol_confirm", volExpansion && bearishBar,
            currentCandle.v / volAvg, volMultVal);

          if (confirmed) {
            const stopPrice = pullbackHigh + ATR_BUFFER * atr1h;
            const stopDist = stopPrice - close;

            const withinCap = ctx.track("S:stop_within_cap",
              stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
            const validStop = ctx.track("S:stop_positive", stopDist > 0, stopDist, 0);

            if (withinCap && validStop) {
              const moveRange = pullbackHigh - priorSwingLow;
              if (moveRange <= 0) {
                resetPullback();
                return null;
              }
              const tpPrice = pullbackHigh - fibExtLevelVal * moveRange;
              const tpDist = close - tpPrice;
              const rr = tpDist / stopDist;
              const rrOk = ctx.track("S:rr_filter", rr >= MIN_RR, rr, MIN_RR);

              if (rrOk) {
                resetPullback();
                return {
                  direction: "short",
                  entryPrice: null,
                  stopLoss: stopPrice,
                  takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
                  comment: `Pullback short: vol=${(currentCandle.v / volAvg).toFixed(1)}x EMA-zone`,
                };
              }
            }
            resetPullback();
            return null;
          }

          if (close < ema15m - emaZoneWidth) {
            resetPullback();
          }
          return null;
        }
      }

      // No trend — reset stale pullback
      if (inPullbackZone && !isUptrend && !isDowntrend) resetPullback();

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory — Rule 7)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle } = ctx;
      const atr1h = findHtf1hAtr(currentCandle.t);
      if (isNaN(atr1h) || atr1h <= 0) return null;

      const close = currentCandle.c;
      const buffer = ATR_BUFFER * atr1h;
      const fibExtLevelVal = params.fibExtLevel.value;

      if (direction === "long") {
        const stopPrice = currentCandle.l - buffer;
        const stopDist = close - stopPrice;
        if (stopDist > STOP_HARD_CAP * atr1h || stopDist <= 0) return null;
        const tpPrice = close + fibExtLevelVal * stopDist;
        return {
          stopLoss: stopPrice,
          takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
        };
      }

      const stopPrice = currentCandle.h + buffer;
      const stopDist = stopPrice - close;
      if (stopDist > STOP_HARD_CAP * atr1h || stopDist <= 0) return null;
      const tpPrice = close - fibExtLevelVal * stopDist;
      return {
        stopLoss: stopPrice,
        takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
      };
    },

    getExitLevel(_ctx: StrategyContext): number | null {
      return null;
    },
  };
}
