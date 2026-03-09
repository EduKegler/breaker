import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import type { BollingerBandsResult } from "../../../indicators/bollinger-bands.js";
import type { KeltnerResult } from "../../../indicators/keltner.js";
import { bollingerBands } from "../../../indicators/bollinger-bands.js";
import { keltner } from "../../../indicators/keltner.js";
import { ema as emaIndicator } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface SqueezeEmaAtrTrailParams {
  bbKcPeriod: StrategyParam;
  kcMult: StrategyParam;
  squeezeLookback: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  atrTrailMult: StrategyParam;
  emaPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: SqueezeEmaAtrTrailParams = {
  bbKcPeriod: {
    value: 20, min: 14, max: 30, step: 2, optimizable: true,
    description: "Shared period for Bollinger Bands and Keltner Channel",
  },
  kcMult: {
    value: 1.5, min: 1.0, max: 2.5, step: 0.25, optimizable: true,
    description: "Keltner Channel multiplier",
  },
  squeezeLookback: {
    value: 15, min: 8, max: 20, step: 1, optimizable: true,
    description: "Bars to look back for recent BB-inside-KC squeeze",
  },
  volMultiplier: {
    value: 1.25, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  atrTrailMult: {
    value: 3.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier",
  },
  emaPeriod: {
    value: 50, min: 20, max: 100, step: 10, optimizable: true,
    description: "EMA period on 4H for regime direction filter",
  },
  timeoutBars: {
    value: 72, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createSqueezeEmaAtrTrail(
  paramOverrides?: Partial<Record<keyof SqueezeEmaAtrTrailParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof SqueezeEmaAtrTrailParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let bbCache: BollingerBandsResult | null = null;
  let kcCache: KeltnerResult | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf4hEmaCache: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function findLast4hIdx(currentT: number, htfRef: Candle[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT) {
        return j;
      }
    }
    return -1;
  }

  return {
    name: "BTC 15m Breakout — Squeeze EMA ATR-Trail",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const period = params.bbKcPeriod.value;
      const closes = candles.map(c => c.c);
      bbCache = bollingerBands(closes, period, 2.0);
      kcCache = keltner(candles, period, period, params.kcMult.value);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      if (htf4hCandles.length > 0) {
        htf4hEmaCache = emaIndicator(htf4hCandles.map(c => c.c), params.emaPeriod.value);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 35) return null;

      const period = params.bbKcPeriod.value;

      // --- BB & KC on 15m closes ---
      const bb = bbCache ?? bollingerBands(candles.map(c => c.c), period, 2.0);
      const kc = kcCache ?? keltner(candles, period, period, params.kcMult.value);

      const bbUpper = bb.upper[index];
      const bbLower = bb.lower[index];
      const kcUpper = kc.upper[index];
      const kcLower = kc.lower[index];

      if (isNaN(bbUpper) || isNaN(kcUpper)) return null;

      // --- Squeeze detection: BB inside KC in lookback window ---
      const currentSqueezeOn = bbLower > kcLower && bbUpper < kcUpper;
      const lookback = Math.round(params.squeezeLookback.value);
      let recentSqueezeCount = 0;
      for (let k = Math.max(0, index - lookback); k < index; k++) {
        const bU = bb.upper[k];
        const bL = bb.lower[k];
        const kU = kc.upper[k];
        const kL = kc.lower[k];
        if (!isNaN(bU) && !isNaN(kL) && bL > kL && bU < kU) {
          recentSqueezeCount++;
        }
      }

      // Release: had at least 1 squeeze bar recently AND current bar is not squeezed
      const hadRecentSqueeze = recentSqueezeCount >= 1;
      const squeezeReleased = hadRecentSqueeze && !currentSqueezeOn;

      // --- HTF: 1H ATR (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- HTF: 4H EMA regime (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 30) return null;
      const ema4h = htf4hEmaCache ?? emaIndicator(htf4hRef.map(c => c.c), params.emaPeriod.value);
      const last4hIdx = findLast4hIdx(currentCandle.t, htf4hRef);
      if (last4hIdx < 0) return null;

      const emaValue = ema4h[last4hIdx];
      const htf4hClose = htf4hRef[last4hIdx].c;
      if (isNaN(emaValue)) return null;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const prevCandle = candles[index - 1];
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;

      // --- Diagnostics ---
      ctx.indicator("bbUpper", bbUpper);
      ctx.indicator("bbLower", bbLower);
      ctx.indicator("kcUpper", kcUpper);
      ctx.indicator("kcLower", kcLower);
      ctx.indicator("squeezeOn", currentSqueezeOn ? 1 : 0);
      ctx.indicator("recentSqueezeCount", recentSqueezeCount);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("ema4h", emaValue);
      ctx.indicator("htf4hClose", htf4hClose);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("close", close);

      // --- LONG: squeeze release + close > prev high + EMA regime + volume ---
      const longSqueeze = ctx.track("L:squeeze_release", squeezeReleased, recentSqueezeCount, 1);
      const longBreakout = ctx.track("L:close_above_prev_high", close > prevCandle.h, close, prevCandle.h);
      const longRegime = ctx.track("L:ema_regime", htf4hClose > emaValue, htf4hClose, emaValue);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longSqueeze && longBreakout && longRegime && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Squeeze release long (EMA)",
        };
      }

      // --- SHORT: squeeze release + close < prev low + EMA regime + volume ---
      const shortSqueeze = ctx.track("S:squeeze_release", squeezeReleased, recentSqueezeCount, 1);
      const shortBreakout = ctx.track("S:close_below_prev_low", close < prevCandle.l, close, prevCandle.l);
      const shortRegime = ctx.track("S:ema_regime", htf4hClose < emaValue, htf4hClose, emaValue);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortSqueeze && shortBreakout && shortRegime && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Squeeze release short (EMA)",
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
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
