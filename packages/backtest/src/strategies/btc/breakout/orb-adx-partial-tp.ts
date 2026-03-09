import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { adx as adxIndicator } from "../../../indicators/adx.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface OrbAdxPartialTpParams {
  orbMinutes: StrategyParam;
  adxThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  partialPct: StrategyParam;
  partialRR: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: OrbAdxPartialTpParams = {
  orbMinutes: {
    value: 30, min: 15, max: 60, step: 15, optimizable: true,
    description: "ORB formation period in minutes (multiples of 15)",
  },
  adxThreshold: {
    value: 20, min: 15, max: 50, step: 5, optimizable: true,
    description: "ADX(14) 4H threshold — entry only when ADX < threshold (consolidation)",
  },
  volMultiplier: {
    value: 2.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB §1.6 >= 3.0)",
  },
  partialPct: {
    value: 0.5, min: 0.3, max: 0.7, step: 0.1, optimizable: true,
    description: "Fraction of position to close at TP1 (0-1)",
  },
  partialRR: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.5, optimizable: true,
    description: "R:R target for partial TP (multiple of stop distance)",
  },
  atrTrailMult: {
    value: 3.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier for remainder",
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

export function createOrbAdxPartialTp(
  paramOverrides?: Partial<Record<keyof OrbAdxPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof OrbAdxPartialTpParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htf4hAdxCache: { adx: number[]; diPlus: number[]; diMinus: number[] } | null = null;

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

  return {
    name: "BTC 15m Breakout — ORB ADX Partial-TP",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hAdxCache = htf4hCandles.length > 0 ? adxIndicator(htf4hCandles, 14) : null;
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

      // --- HTF: 4H ADX (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 28) return null;
      const htfAdx = htf4hAdxCache ?? adxIndicator(htf4hRef, 14);
      let adx4h = NaN;
      for (let j = htf4hRef.length - 1; j >= 0; j--) {
        if (htf4hRef[j].t + MS_4H <= currentCandle.t && !isNaN(htfAdx.adx[j])) {
          adx4h = htfAdx.adx[j];
          break;
        }
      }
      if (isNaN(adx4h)) return null;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;
      const adxThresh = params.adxThreshold.value;

      // --- Diagnostics ---
      ctx.indicator("orbHigh", orbHigh);
      ctx.indicator("orbLow", orbLow);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("close", close);

      // --- LONG: close above orbHigh + ADX < threshold + volume spike ---
      const longBreakout = ctx.track("L:close_above_orb", close > orbHigh, close, orbHigh);
      const longAdx = ctx.track("L:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreakout && longAdx && longVol) {
        const sl = close - stopDist;
        const tpPrice = close + params.partialRR.value * stopDist;
        orbArmed = false;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [{ price: tpPrice, pctOfPosition: params.partialPct.value }],
          comment: "ORB breakout long",
        };
      }

      // --- SHORT: close below orbLow + ADX < threshold + volume spike ---
      const shortBreakout = ctx.track("S:close_below_orb", close < orbLow, close, orbLow);
      const shortAdx = ctx.track("S:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreakout && shortAdx && shortVol) {
        const sl = close + stopDist;
        const tpPrice = close - params.partialRR.value * stopDist;
        orbArmed = false;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [{ price: tpPrice, pctOfPosition: params.partialPct.value }],
          comment: "ORB breakout short",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      // Timeout first (mandatory)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // ATR trailing stop for remainder after partial TP
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
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
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
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
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1h)) return null;

      const stopDist = atr1h * params.atrStopMult.value;
      const close = currentCandle.c;

      if (direction === "long") {
        const sl = close - stopDist;
        const tpPrice = close + params.partialRR.value * stopDist;
        return { stopLoss: sl, takeProfits: [{ price: tpPrice, pctOfPosition: params.partialPct.value }] };
      } else {
        const sl = close + stopDist;
        const tpPrice = close - params.partialRR.value * stopDist;
        return { stopLoss: sl, takeProfits: [{ price: tpPrice, pctOfPosition: params.partialPct.value }] };
      }
    },
  };
}
