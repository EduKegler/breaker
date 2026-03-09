import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { donchian } from "../../../indicators/donchian.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface OrbConsolidationTrailDcParams {
  orbMinutes: StrategyParam;
  consolidationLookback: StrategyParam;
  consolidationAtrThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  trailDcPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: OrbConsolidationTrailDcParams = {
  orbMinutes: {
    value: 30, min: 15, max: 60, step: 15, optimizable: true,
    description: "ORB formation period in minutes (multiples of 15)",
  },
  consolidationLookback: {
    value: 6, min: 3, max: 12, step: 1, optimizable: true,
    description: "Number of 4H candles to measure range width for consolidation",
  },
  consolidationAtrThreshold: {
    value: 1.25, min: 1.0, max: 4.0, step: 0.25, optimizable: true,
    description: "Max range width as multiple of ATR(14) 4H — below = consolidation",
  },
  volMultiplier: {
    value: 2.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  trailDcPeriod: {
    value: 10, min: 5, max: 20, step: 1, optimizable: true,
    description: "Fast Donchian period for trailing channel exit (opposite band)",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

function getSessionOpen(t: number): "london" | "ny" | null {
  const d = new Date(t);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (h === 8 && m === 0) return "london";
  if (h === 13 && m === 30) return "ny";
  return null;
}

export function createOrbConsolidationTrailDc(
  paramOverrides?: Partial<Record<keyof OrbConsolidationTrailDcParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof OrbConsolidationTrailDcParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let exitDcCache: { upper: number[]; lower: number[]; mid: number[] } | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfAtrCache4h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;

  // ORB bar-by-bar state
  let orbHigh = NaN;
  let orbLow = NaN;
  let orbBarsLeft = 0;
  let orbArmed = false;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function findConsolidation4h(
    currentT: number, htfRef: Candle[], htfAtr: number[],
    lookback: number, threshold: number,
  ): { isConsolidation: boolean; htfRange: number; consThresholdAbs: number; atr4h: number } | null {
    // Find last completed 4H bar
    let last4hIdx = -1;
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT) {
        last4hIdx = j;
        break;
      }
    }
    if (last4hIdx < 0 || last4hIdx < lookback - 1) return null;

    const atr4h = htfAtr[last4hIdx];
    if (isNaN(atr4h)) return null;

    // Measure range over last N 4H candles
    let rangeHigh = -Infinity;
    let rangeLow = Infinity;
    for (let j = last4hIdx - lookback + 1; j <= last4hIdx; j++) {
      if (j < 0) return null;
      rangeHigh = Math.max(rangeHigh, htfRef[j].h);
      rangeLow = Math.min(rangeLow, htfRef[j].l);
    }
    const htfRange = rangeHigh - rangeLow;
    const consThresholdAbs = threshold * atr4h;
    return { isConsolidation: htfRange < consThresholdAbs, htfRange, consThresholdAbs, atr4h };
  }

  return {
    name: "BTC 15m Breakout — ORB Consolidation Trail-DC",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 20 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      exitDcCache = donchian(candles, params.trailDcPeriod.value);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfAtrCache4h = htf4hCandles.length > 0 ? atr(htf4hCandles, 14) : null;
      orbHigh = NaN;
      orbLow = NaN;
      orbBarsLeft = 0;
      orbArmed = false;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 20) return null;

      const orbBarsCount = Math.max(1, Math.round(params.orbMinutes.value / 15));

      // --- ORB state update ---
      const session = getSessionOpen(currentCandle.t);
      if (session) {
        orbHigh = currentCandle.h;
        orbLow = currentCandle.l;
        orbBarsLeft = orbBarsCount - 1;
        orbArmed = orbBarsLeft === 0;
        return null; // never enter on session-open bar
      }

      if (orbBarsLeft > 0) {
        orbHigh = Math.max(orbHigh, currentCandle.h);
        orbLow = Math.min(orbLow, currentCandle.l);
        orbBarsLeft--;
        if (orbBarsLeft === 0) orbArmed = true;
        return null; // still forming
      }

      if (!orbArmed || isNaN(orbHigh) || isNaN(orbLow)) return null;

      // --- HTF: 1H ATR (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- 4H Consolidation regime filter (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 20) return null;
      const htfAtr4h = htfAtrCache4h ?? atr(htf4hRef, 14);
      const consResult = findConsolidation4h(
        currentCandle.t, htf4hRef, htfAtr4h,
        params.consolidationLookback.value, params.consolidationAtrThreshold.value,
      );
      if (!consResult) return null;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;

      // --- Diagnostics ---
      ctx.indicator("orbHigh", orbHigh);
      ctx.indicator("orbLow", orbLow);
      ctx.indicator("close", close);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("atr4h", consResult.atr4h);
      ctx.indicator("htfRange4h", consResult.htfRange);
      ctx.indicator("consThreshold", consResult.consThresholdAbs);
      ctx.indicator("volAvg20", volAvg20);

      // --- LONG: close above orbHigh + 4H consolidation + volume spike ---
      const longBreakout = ctx.track("L:close_above_orb", close > orbHigh, close, orbHigh);
      const longRegime = ctx.track("L:4h_consolidation", consResult.isConsolidation, consResult.htfRange, consResult.consThresholdAbs);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreakout && longRegime && longVol) {
        const sl = close - stopDist;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "ORB breakout long (4H consolidation)",
        };
      }

      // --- SHORT: close below orbLow + 4H consolidation + volume spike ---
      const shortBreakout = ctx.track("S:close_below_orb", close < orbLow, close, orbLow);
      const shortRegime = ctx.track("S:4h_consolidation", consResult.isConsolidation, consResult.htfRange, consResult.consThresholdAbs);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreakout && shortRegime && shortVol) {
        const sl = close + stopDist;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "ORB breakout short (4H consolidation)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, candles, currentCandle, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory — Rule 5)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Session change exit — ORB trades should resolve within session
      if (getSessionOpen(currentCandle.t)) {
        return { exit: true, comment: "Session change" };
      }

      // Trailing Donchian channel exit (opposite band)
      const trailPeriod = params.trailDcPeriod.value;
      if (barsInTrade < trailPeriod) return null; // need enough bars for channel

      const exitDc = exitDcCache ?? donchian(candles.slice(0, index + 1), trailPeriod);
      const close = currentCandle.c;

      if (positionDirection === "long") {
        const exitLevel = exitDc.lower[index - 1]; // previous bar's lower channel
        if (!isNaN(exitLevel) && close < exitLevel) {
          return { exit: true, comment: "Trail DC" };
        }
      } else {
        const exitLevel = exitDc.upper[index - 1]; // previous bar's upper channel
        if (!isNaN(exitLevel) && close > exitLevel) {
          return { exit: true, comment: "Trail DC" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, candles, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      const trailPeriod = params.trailDcPeriod.value;
      if (barsInTrade < trailPeriod) return null;

      const exitDc = exitDcCache ?? donchian(candles.slice(0, index + 1), trailPeriod);

      if (positionDirection === "long") {
        return exitDc.lower[index - 1] ?? null;
      } else {
        return exitDc.upper[index - 1] ?? null;
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
