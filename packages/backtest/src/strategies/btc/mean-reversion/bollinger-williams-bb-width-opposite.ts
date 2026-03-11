import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { bollingerBands } from "../../../indicators/bollinger-bands.js";
import { williamsR } from "../../../indicators/williams-r.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;

// Fixed constants (not optimizable)
const WR_PERIOD = 14; // Williams %R lookback
const SHORT_TIMEOUT_RATIO = 0.67; // timeout_short = timeout_long × 0.67
const VIRTUAL_STOP_ATR_MULT = 5.0; // Wide catastrophic stop for position sizing
const HTF_BB_PERIOD = 20; // BB period for 1H regime filter
const HTF_BB_MULT = 2.0; // BB multiplier for 1H regime filter
const BB_WIDTH_LOOKBACK = 100; // 1H bars to compute width percentile over

interface BollingerWilliamsBbWidthOppositeParams {
  bbPeriod: StrategyParam;
  bbMultiplier: StrategyParam;
  wrThreshLong: StrategyParam;
  wrThreshShort: StrategyParam;
  bbWidthPctile: StrategyParam;
  timeoutBarsLong: StrategyParam;
}

const DEFAULT_PARAMS: BollingerWilliamsBbWidthOppositeParams = {
  bbPeriod: {
    value: 20, min: 10, max: 40, step: 2, optimizable: true,
    description: "Bollinger Bands SMA period for midline and band calculation",
  },
  bbMultiplier: {
    value: 2.0, min: 1.0, max: 3.5, step: 0.25, optimizable: true,
    description: "BB std dev multiplier — distance from midline to upper/lower bands",
  },
  wrThreshLong: {
    value: -90, min: -98, max: -70, step: 2, optimizable: true,
    description: "Williams %R must be below this to enter long (oversold)",
  },
  wrThreshShort: {
    value: -10, min: -30, max: -2, step: 2, optimizable: true,
    description: "Williams %R must be above this to enter short (overbought)",
  },
  bbWidthPctile: {
    value: 40, min: 15, max: 60, step: 5, optimizable: true,
    description: "BB width percentile on 1H must be below this — low vol = ranging regime gate",
  },
  timeoutBarsLong: {
    value: 24, min: 8, max: 48, step: 4, optimizable: true,
    description: "Forced exit after N bars for longs (shorts = N × 0.67)",
  },
};

/** Compute percentile rank of value within sorted array (0-100) */
function percentileRank(arr: number[], value: number): number {
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] <= value) count++;
  }
  return (count / arr.length) * 100;
}

export function createBollingerWilliamsBbWidthOpposite(
  paramOverrides?: Partial<Record<keyof BollingerWilliamsBbWidthOppositeParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof BollingerWilliamsBbWidthOppositeParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let bbCache: { upper: number[]; mid: number[]; lower: number[] } | null = null;
  let wrCache: number[] | null = null;
  let htfBbCache1h: { upper: number[]; mid: number[]; lower: number[] } | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  // Pre-computed BB width array for 1H (bandwidth = (upper - lower) / mid)
  let htfBbWidthCache1h: number[] | null = null;

  /** Anti-repaint: find last fully-closed 1H candle index */
  function findHtf1hIndex(currentT: number, htfRef: Candle[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT) {
        return j;
      }
    }
    return -1;
  }

  /** Anti-repaint: find last fully-closed 1H candle value */
  function findHtf1hValue(currentT: number, htfRef: Candle[], values: number[]): number {
    const idx = findHtf1hIndex(currentT, htfRef);
    if (idx < 0 || isNaN(values[idx])) return NaN;
    return values[idx];
  }

  /** Compute BB width percentile at a given 1H index using lookback window */
  function computeBbWidthPercentile(htfIdx: number, widths: number[]): number {
    if (htfIdx < 0 || isNaN(widths[htfIdx])) return NaN;
    const start = Math.max(0, htfIdx - BB_WIDTH_LOOKBACK + 1);
    const window: number[] = [];
    for (let i = start; i <= htfIdx; i++) {
      if (!isNaN(widths[i])) window.push(widths[i]);
    }
    if (window.length < 20) return NaN; // Not enough data for meaningful percentile
    return percentileRank(window, widths[htfIdx]);
  }

  return {
    name: "BTC 15m Mean Reversion — Bollinger Williams BB-Width Opposite",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 50, "1h": 120 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const period = Math.round(params.bbPeriod.value);
      bbCache = bollingerBands(candles.map((c) => c.c), period, params.bbMultiplier.value);
      wrCache = williamsR(candles, WR_PERIOD);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfBbCache1h = bollingerBands(htf1hCandles.map((c) => c.c), HTF_BB_PERIOD, HTF_BB_MULT);
        htfAtrCache1h = atr(htf1hCandles, 14);
        // Pre-compute BB width for 1H
        htfBbWidthCache1h = htfBbCache1h.upper.map((u, i) => {
          const mid = htfBbCache1h!.mid[i];
          if (isNaN(u) || isNaN(mid) || mid === 0) return NaN;
          return (u - htfBbCache1h!.lower[i]) / mid;
        });
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, higherTimeframes } = ctx;
      const period = Math.round(params.bbPeriod.value);
      if (index < period + WR_PERIOD) return null;
      if (ctx.positionDirection) return null;

      // Previous-bar indicators (avoid look-ahead bias)
      const prev = index - 1;
      const bbUpper = bbCache ? bbCache.upper[prev] : NaN;
      const bbLower = bbCache ? bbCache.lower[prev] : NaN;
      const bbMid = bbCache ? bbCache.mid[prev] : NaN;
      const wrVal = wrCache ? wrCache[prev] : NaN;
      if (isNaN(bbUpper) || isNaN(bbLower) || isNaN(bbMid) || isNaN(wrVal)) return null;

      // HTF: 1H BB width percentile regime gate (anti-repaint — last closed 1H candle)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 120) return null;
      const bbWidths = htfBbWidthCache1h ?? (() => {
        const bb1h = bollingerBands(htf1hRef.map((c) => c.c), HTF_BB_PERIOD, HTF_BB_MULT);
        return bb1h.upper.map((u, i) => {
          const mid = bb1h.mid[i];
          if (isNaN(u) || isNaN(mid) || mid === 0) return NaN;
          return (u - bb1h.lower[i]) / mid;
        });
      })();
      const htfIdx = findHtf1hIndex(currentCandle.t, htf1hRef);
      if (htfIdx < 0) return null;
      const bbWidthPctileVal = computeBbWidthPercentile(htfIdx, bbWidths);
      if (isNaN(bbWidthPctileVal)) return null;

      // HTF: 1H ATR for virtual stop (position sizing)
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findHtf1hValue(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      const close = currentCandle.c;
      const bbWidthThresh = params.bbWidthPctile.value;
      const virtualStopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;

      // Diagnostics
      ctx.indicator("bbUpper", bbUpper);
      ctx.indicator("bbLower", bbLower);
      ctx.indicator("bbMid", bbMid);
      ctx.indicator("wrValue", wrVal);
      ctx.indicator("bbWidthPctile1h", bbWidthPctileVal);
      ctx.indicator("atr1h", atr1hVal);

      // --- LONG: close at/below BB lower band + Williams %R oversold + BB width low (ranging) ---
      const longBand = ctx.track("L:below_bb_lower", close <= bbLower, close, bbLower);
      const longWr = ctx.track("L:wr_oversold", wrVal <= params.wrThreshLong.value, wrVal, params.wrThreshLong.value);
      const longRegime = ctx.track("L:bb_width_ranging", bbWidthPctileVal < bbWidthThresh, bbWidthPctileVal, bbWidthThresh);

      if (longBand && longWr && longRegime) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - virtualStopDist,
          takeProfits: [],
          comment: "BB lower + WR oversold (MR long)",
        };
      }

      // --- SHORT: close at/above BB upper band + Williams %R overbought + BB width low (ranging) ---
      const shortBand = ctx.track("S:above_bb_upper", close >= bbUpper, close, bbUpper);
      const shortWr = ctx.track("S:wr_overbought", wrVal >= params.wrThreshShort.value, wrVal, params.wrThreshShort.value);
      const shortRegime = ctx.track("S:bb_width_ranging", bbWidthPctileVal < bbWidthThresh, bbWidthPctileVal, bbWidthThresh);

      if (shortBand && shortWr && shortRegime) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + virtualStopDist,
          takeProfits: [],
          comment: "BB upper + WR overbought (MR short)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      const timeoutLong = Math.round(params.timeoutBarsLong.value);
      const timeoutShort = Math.round(timeoutLong * SHORT_TIMEOUT_RATIO);

      // Timeout exit (asymmetric: shorts have shorter timeout) — checked first per rules
      if (ctx.positionDirection === "long" && barsInTrade >= timeoutLong) {
        return { exit: true, comment: "Timeout (long)" };
      }
      if (ctx.positionDirection === "short" && barsInTrade >= timeoutShort) {
        return { exit: true, comment: "Timeout (short)" };
      }

      // Opposite band exit — reversion target is the opposite extreme
      const prev = ctx.index - 1;
      const bbUpper = bbCache ? bbCache.upper[prev] : NaN;
      const bbLower = bbCache ? bbCache.lower[prev] : NaN;
      if (isNaN(bbUpper) || isNaN(bbLower)) return null;

      if (ctx.positionDirection === "long" && ctx.currentCandle.c >= bbUpper) {
        return { exit: true, comment: "Opposite band reached (long → upper BB)" };
      }
      if (ctx.positionDirection === "short" && ctx.currentCandle.c <= bbLower) {
        return { exit: true, comment: "Opposite band reached (short → lower BB)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      if (!ctx.positionDirection) return null;
      const prev = ctx.index - 1;
      if (ctx.positionDirection === "long") {
        return bbCache ? bbCache.upper[prev] : null;
      }
      return bbCache ? bbCache.lower[prev] : null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findHtf1hValue(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;
      const close = currentCandle.c;

      if (direction === "long") {
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
