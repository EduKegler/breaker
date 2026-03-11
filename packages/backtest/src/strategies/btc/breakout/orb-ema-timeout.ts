import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema as emaIndicator } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

interface OrbEmaTimeoutParams {
  orbBars: StrategyParam;
  emaPeriod: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: OrbEmaTimeoutParams = {
  orbBars: {
    value: 4, min: 2, max: 8, step: 1, optimizable: true,
    description: "15m bars for ORB range (4 = 1 hour opening range)",
  },
  emaPeriod: {
    value: 50, min: 10, max: 50, step: 5, optimizable: true,
    description: "Daily EMA period for regime filter",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  atrTrailMult: {
    value: 4.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier for exit",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createOrbEmaTimeout(
  paramOverrides?: Partial<Record<keyof OrbEmaTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof OrbEmaTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf1dCandles: Candle[] | null = null;
  let htf1dEmaCache: number[] | null = null;

  // ORB session state (mutable across bars)
  let currentSessionDay = -1;
  let orHigh = NaN;
  let orLow = NaN;
  let orbBarsCollected = 0;
  let orbArmed = false;
  let longTaken = false;
  let shortTaken = false;

  function findAtr1h(currentT: number, ref: Candle[], vals: number[]): number {
    for (let j = ref.length - 1; j >= 0; j--) {
      if (ref[j].t + MS_1H <= currentT && !isNaN(vals[j])) return vals[j];
    }
    return NaN;
  }

  function findDailyEma(currentT: number): { emaVal: number; dailyClose: number } {
    if (!htf1dCandles || !htf1dEmaCache) return { emaVal: NaN, dailyClose: NaN };
    for (let j = htf1dCandles.length - 1; j >= 0; j--) {
      if (htf1dCandles[j].t + MS_1D <= currentT && !isNaN(htf1dEmaCache[j])) {
        return { emaVal: htf1dEmaCache[j], dailyClose: htf1dCandles[j].c };
      }
    }
    return { emaVal: NaN, dailyClose: NaN };
  }

  return {
    name: "BTC 15m Breakout — ORB EMA Timeout",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 50, "1h": 15, "1d": 60 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf1dCandles = higherTimeframes["1d"] ?? [];
      htf1dEmaCache = htf1dCandles.length > 0
        ? emaIndicator(htf1dCandles.map(c => c.c), params.emaPeriod.value)
        : null;

      currentSessionDay = -1;
      orHigh = NaN;
      orLow = NaN;
      orbBarsCollected = 0;
      orbArmed = false;
      longTaken = false;
      shortTaken = false;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 30) return null;

      // Skip if already in position
      if (ctx.positionDirection) return null;

      const close = currentCandle.c;
      const orbBarsVal = params.orbBars.value;

      // ────── Session tracking (UTC daily open at 00:00) ──────
      const candleDay = Math.floor(currentCandle.t / MS_1D);
      if (candleDay !== currentSessionDay) {
        currentSessionDay = candleDay;
        orHigh = currentCandle.h;
        orLow = currentCandle.l;
        orbBarsCollected = 1;
        orbArmed = orbBarsCollected >= orbBarsVal;
        longTaken = false;
        shortTaken = false;
        ctx.indicator("orHigh", orHigh);
        ctx.indicator("orLow", orLow);
        ctx.indicator("orbArmed", orbArmed ? 1 : 0);
        return null; // never enter on session-open bar
      }

      // Still collecting ORB range bars
      if (!orbArmed && orbBarsCollected > 0) {
        orHigh = Math.max(orHigh, currentCandle.h);
        orLow = Math.min(orLow, currentCandle.l);
        orbBarsCollected++;
        if (orbBarsCollected >= orbBarsVal) orbArmed = true;
        ctx.indicator("orHigh", orHigh);
        ctx.indicator("orLow", orLow);
        ctx.indicator("orbArmed", orbArmed ? 1 : 0);
        return null; // still forming
      }

      // Not armed — no ORB range
      if (!orbArmed || isNaN(orHigh) || isNaN(orLow)) return null;

      ctx.indicator("orHigh", orHigh);
      ctx.indicator("orLow", orLow);
      ctx.indicator("orbArmed", 1);

      // ────── 1H ATR (anti-repaint: completed bar only) ──────
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      // ────── Daily EMA regime (anti-repaint: completed bar only) ──────
      const { emaVal, dailyClose } = findDailyEma(currentCandle.t);
      ctx.indicator("dailyEma", emaVal);
      ctx.indicator("dailyClose", dailyClose);
      ctx.indicator("atr1h", atr1hVal);

      // ────── Volume SMA(20) ──────
      const volArr = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volArr[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("volThreshold", volThreshold);

      const stopDist = atr1hVal * params.atrStopMult.value;

      // ────── LONG: close above OR high + daily close > EMA + volume ──────
      const longBreak = ctx.track("L:close_above_orb", close > orHigh, close, orHigh);
      const longRegime = ctx.track("L:above_daily_ema", !isNaN(dailyClose) && dailyClose > emaVal, dailyClose, emaVal);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (!longTaken && longBreak && longRegime && longVol) {
        longTaken = true;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "ORB long breakout (EMA regime)",
        };
      }

      // ────── SHORT: close below OR low + daily close < EMA + volume ──────
      const shortBreak = ctx.track("S:close_below_orb", close < orLow, close, orLow);
      const shortRegime = ctx.track("S:below_daily_ema", !isNaN(dailyClose) && dailyClose < emaVal, dailyClose, emaVal);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (!shortTaken && shortBreak && shortRegime && shortVol) {
        shortTaken = true;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "ORB short breakout (EMA regime)",
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
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * params.atrStopMult.value;
      const close = currentCandle.c;

      if (direction === "long") {
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
