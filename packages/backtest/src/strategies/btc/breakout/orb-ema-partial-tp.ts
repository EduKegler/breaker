import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;
const TP1_PCT = 0.35;
const TP2_PCT = 0.35;

interface OrbEmaPartialTpParams {
  orbWindowBars: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  tp1RR: StrategyParam;
  tp2RR: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: OrbEmaPartialTpParams = {
  orbWindowBars: {
    value: 4, min: 1, max: 4, step: 1, optimizable: true,
    description: "15m bars for ORB range (1=15min, 2=30min, 4=60min)",
  },
  volMultiplier: {
    value: 2, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  tp1RR: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.5, optimizable: true,
    description: "TP1 take profit R:R ratio (closes 35% of position)",
  },
  tp2RR: {
    value: 3.0, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "TP2 take profit R:R ratio (closes 35%, remaining 30% trails). Must be > tp1RR",
  },
  atrTrailMult: {
    value: 2.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier for remaining 30% of position",
  },
  timeoutBars: {
    value: 64, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

// DST-aware session formatters
const londonHourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/London",
  hour: "numeric",
  hourCycle: "h23",
});
const nyHourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});

export function createOrbEmaPartialTp(
  paramOverrides?: Partial<Record<keyof OrbEmaPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof OrbEmaPartialTpParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfEmaCache1d: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf1dCandles: Candle[] | null = null;
  let sessionOpens: Map<number, "london" | "ny"> | null = null;

  // ORB state (mutable across bars)
  let orbHigh = NaN;
  let orbLow = NaN;
  let orbBarsCollected = 0;
  let orbArmed = false;

  function findAtr1h(currentT: number, ref: Candle[], vals: number[]): number {
    for (let j = ref.length - 1; j >= 0; j--) {
      if (ref[j].t + MS_1H <= currentT && !isNaN(vals[j])) return vals[j];
    }
    return NaN;
  }

  function findDailyEma(currentT: number, ref: Candle[], vals: number[]): number {
    for (let j = ref.length - 1; j >= 0; j--) {
      if (ref[j].t + MS_1D <= currentT && !isNaN(vals[j])) return vals[j];
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — ORB EMA Partial-TP",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 50, "1h": 15, "1d": 210 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf1dCandles = higherTimeframes["1d"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfEmaCache1d = htf1dCandles.length > 0 ? ema(htf1dCandles.map(c => c.c), 200) : null;

      // Precompute session open bar indices (DST-aware via Intl.DateTimeFormat)
      // London opens 08:00 local → UTC 07:00 (BST) or 08:00 (GMT)
      // NY opens 09:30 local → UTC 13:30 (EDT) or 14:30 (EST)
      sessionOpens = new Map();
      for (let i = 0; i < candles.length; i++) {
        const d = new Date(candles[i].t);
        const utcH = d.getUTCHours();
        const utcM = d.getUTCMinutes();

        if (utcM === 0 && (utcH === 7 || utcH === 8)) {
          const parts = londonHourFmt.formatToParts(d);
          const localH = parseInt(parts.find(p => p.type === "hour")!.value);
          if (localH === 8) {
            sessionOpens.set(i, "london");
            continue;
          }
        }

        if (utcM === 30 && (utcH === 13 || utcH === 14)) {
          const parts = nyHourFmt.formatToParts(d);
          const localH = parseInt(parts.find(p => p.type === "hour")!.value);
          if (localH === 9) {
            sessionOpens.set(i, "ny");
          }
        }
      }

      orbHigh = NaN;
      orbLow = NaN;
      orbBarsCollected = 0;
      orbArmed = false;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 30) return null;

      const windowBars = params.orbWindowBars.value;

      // Session open detected → reset ORB formation
      const session = sessionOpens?.get(index);
      if (session) {
        orbHigh = currentCandle.h;
        orbLow = currentCandle.l;
        orbBarsCollected = 1;
        orbArmed = orbBarsCollected >= windowBars;
        ctx.indicator("orbHigh", orbHigh);
        ctx.indicator("orbLow", orbLow);
        ctx.indicator("orbArmed", orbArmed ? 1 : 0);
        return null; // never enter on session-open bar
      }

      // Still collecting ORB range bars
      if (orbBarsCollected > 0 && !orbArmed) {
        orbHigh = Math.max(orbHigh, currentCandle.h);
        orbLow = Math.min(orbLow, currentCandle.l);
        orbBarsCollected++;
        if (orbBarsCollected >= windowBars) orbArmed = true;
        ctx.indicator("orbHigh", orbHigh);
        ctx.indicator("orbLow", orbLow);
        ctx.indicator("orbArmed", orbArmed ? 1 : 0);
        return null; // still forming
      }

      // Not armed — no ORB range established
      if (!orbArmed || isNaN(orbHigh) || isNaN(orbLow)) return null;

      ctx.indicator("orbHigh", orbHigh);
      ctx.indicator("orbLow", orbLow);
      ctx.indicator("orbArmed", 1);

      // 1H ATR for stop (anti-repaint: completed bar only)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      // Daily EMA(200) regime — only completed bars (anti-repaint)
      const htf1dRef = htf1dCandles ?? higherTimeframes["1d"];
      if (!htf1dRef || htf1dRef.length < 200) return null;
      const htfEma = htfEmaCache1d ?? ema(htf1dRef.map(c => c.c), 200);
      const dailyEma200 = findDailyEma(currentCandle.t, htf1dRef, htfEma);
      if (isNaN(dailyEma200)) return null;

      // Daily close for regime check (last completed daily candle)
      let dailyClose = NaN;
      for (let j = htf1dRef.length - 1; j >= 0; j--) {
        if (htf1dRef[j].t + MS_1D <= currentCandle.t) {
          dailyClose = htf1dRef[j].c;
          break;
        }
      }
      if (isNaN(dailyClose)) return null;

      // Volume SMA(20) — Rule 3
      const volArr = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volArr[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopDist = atr1hVal * params.atrStopMult.value;
      const risk = stopDist;

      ctx.indicator("atr1h", atr1hVal);
      ctx.indicator("dailyEma200", dailyEma200);
      ctx.indicator("dailyClose", dailyClose);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("close", close);

      // LONG: close above ORB high + Daily above EMA(200) + volume spike
      const longBreak = ctx.track("L:close_above_orb", close > orbHigh, close, orbHigh);
      const longRegime = ctx.track("L:daily_above_ema", dailyClose > dailyEma200, dailyClose, dailyEma200);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreak && longRegime && longVol) {
        const sl = close - stopDist;
        orbArmed = false;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [
            { price: close + params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close + params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
          comment: "ORB breakout long (EMA regime)",
        };
      }

      // SHORT: close below ORB low + Daily below EMA(200) + volume spike
      const shortBreak = ctx.track("S:close_below_orb", close < orbLow, close, orbLow);
      const shortRegime = ctx.track("S:daily_below_ema", dailyClose < dailyEma200, dailyClose, dailyEma200);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreak && shortRegime && shortVol) {
        const sl = close + stopDist;
        orbArmed = false;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [
            { price: close - params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close - params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
          comment: "ORB breakout short (EMA regime)",
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

      // ATR trailing stop for remainder after partial TPs
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
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * params.atrStopMult.value;
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
