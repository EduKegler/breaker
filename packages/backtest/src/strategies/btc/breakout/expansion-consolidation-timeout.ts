import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface ExpansionConsolidationTimeoutParams {
  expansionMult: StrategyParam;
  consolidationBars: StrategyParam;
  consolidationWidth: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: ExpansionConsolidationTimeoutParams = {
  expansionMult: {
    value: 1.2, min: 1.0, max: 2.5, step: 0.1, optimizable: true,
    description: "ATR expansion threshold: current ATR(14,15m) > X * SMA(ATR,20)",
  },
  consolidationBars: {
    value: 4, min: 3, max: 12, step: 1, optimizable: true,
    description: "Number of 4H bars to measure consolidation range",
  },
  consolidationWidth: {
    value: 3.0, min: 1.5, max: 5.0, step: 0.5, optimizable: true,
    description: "Max 4H range as multiple of ATR(14,4H) for consolidation regime",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  timeoutBars: {
    value: 64, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createExpansionConsolidationTimeout(
  paramOverrides?: Partial<Record<keyof ExpansionConsolidationTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof ExpansionConsolidationTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let atrSmaCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htfAtrCache4h: number[] | null = null;

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
    name: "BTC 15m Breakout — Expansion Consolidation Timeout",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 20 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      atrSmaCache = sma(atr15mCache, 20);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache4h = htf4hCandles.length > 0 ? atr(htf4hCandles, 14) : null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 30) return null;

      // --- ATR expansion on 15m ---
      const atr15m = atr15mCache ?? atr(candles, 14);
      const atrSma20 = atrSmaCache ?? sma(atr15m, 20);
      const currentAtr = atr15m[index];
      const avgAtr = atrSma20[index];
      if (isNaN(currentAtr) || isNaN(avgAtr) || avgAtr === 0) return null;

      const expMult = params.expansionMult.value;
      const expansionLevel = expMult * avgAtr;

      // --- HTF: 1H ATR (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- 4H consolidation regime (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 20) return null;
      const htfAtr4h = htfAtrCache4h ?? atr(htf4hRef, 14);
      const last4hIdx = findLast4hIdx(currentCandle.t, htf4hRef);
      if (last4hIdx < 0) return null;

      const consLookback = Math.round(params.consolidationBars.value);
      const consThreshold = params.consolidationWidth.value;
      if (last4hIdx < consLookback) return null;

      const atr4h = htfAtr4h[last4hIdx];
      if (isNaN(atr4h) || atr4h === 0) return null;

      let rangeHigh4h = -Infinity;
      let rangeLow4h = Infinity;
      for (let j = last4hIdx - consLookback + 1; j <= last4hIdx; j++) {
        if (j < 0) continue;
        rangeHigh4h = Math.max(rangeHigh4h, htf4hRef[j].h);
        rangeLow4h = Math.min(rangeLow4h, htf4hRef[j].l);
      }
      const htfRange = rangeHigh4h - rangeLow4h;
      const consThresholdAbs = consThreshold * atr4h;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const open = currentCandle.o;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;

      // --- Diagnostics ---
      ctx.indicator("currentAtr15m", currentAtr);
      ctx.indicator("avgAtr15m", avgAtr);
      ctx.indicator("expansionLevel", expansionLevel);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("htfRange4h", htfRange);
      ctx.indicator("consThresholdAbs", consThresholdAbs);
      ctx.indicator("volAvg20", volAvg20);

      // --- LONG: ATR expansion + bullish close + 4H consolidation + volume spike ---
      const longExpansion = ctx.track("L:atr_expansion", currentAtr > expansionLevel, currentAtr, expansionLevel);
      const longBullish = ctx.track("L:bullish_close", close > open, close, open);
      const longConsol = ctx.track("L:4h_consolidation", htfRange < consThresholdAbs, htfRange, consThresholdAbs);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longExpansion && longBullish && longConsol && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Expansion breakout long (4H consolidation)",
        };
      }

      // --- SHORT: ATR expansion + bearish close + 4H consolidation + volume spike ---
      const shortExpansion = ctx.track("S:atr_expansion", currentAtr > expansionLevel, currentAtr, expansionLevel);
      const shortBearish = ctx.track("S:bearish_close", close < open, close, open);
      const shortConsol = ctx.track("S:4h_consolidation", htfRange < consThresholdAbs, htfRange, consThresholdAbs);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortExpansion && shortBearish && shortConsol && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Expansion breakout short (4H consolidation)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      return null;
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
