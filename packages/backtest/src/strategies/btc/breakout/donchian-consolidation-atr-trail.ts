import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { donchian } from "../../../indicators/donchian.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface DonchianConsolidationAtrTrailParams {
  donchianPeriod: StrategyParam;
  consolidationLookback: StrategyParam;
  consolidationAtrThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: DonchianConsolidationAtrTrailParams = {
  donchianPeriod: {
    value: 20, min: 10, max: 30, step: 2, optimizable: true,
    description: "Donchian channel period for breakout detection",
  },
  consolidationLookback: {
    value: 6, min: 3, max: 12, step: 1, optimizable: true,
    description: "4H bars to measure consolidation range",
  },
  consolidationAtrThreshold: {
    value: 2.5, min: 1.0, max: 4.0, step: 0.5, optimizable: true,
    description: "Max 4H range as multiple of ATR(14,4H) for consolidation",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB §1.6 >= 3.0)",
  },
  atrTrailMult: {
    value: 5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier",
  },
  timeoutBars: {
    value: 72, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createDonchianConsolidationAtrTrail(
  paramOverrides?: Partial<Record<keyof DonchianConsolidationAtrTrailParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof DonchianConsolidationAtrTrailParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let donchianCache: { upper: number[]; lower: number[] } | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfAtrCache4h: number[] | null = null;
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

  return {
    name: "BTC 15m Breakout — Donchian Consolidation ATR Trail",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      donchianCache = donchian(candles, params.donchianPeriod.value);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfAtrCache4h = htf4hCandles.length > 0 ? atr(htf4hCandles, 14) : null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const period = params.donchianPeriod.value;
      if (index < period + 14) return null;

      // Donchian Channel on 15m
      const dc = donchianCache ?? donchian(candles.slice(0, index + 1), period);
      const dcUpper = dc.upper[index - 1]; // previous bar's upper (breakout level)
      const dcLower = dc.lower[index - 1]; // previous bar's lower (breakout level)
      if (isNaN(dcUpper) || isNaN(dcLower)) return null;

      // 1H ATR — only completed bars (anti-repaint)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // 4H consolidation regime (anti-repaint)
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 20) return null;
      const htfAtr4h = htfAtrCache4h ?? atr(htf4hRef, 14);
      const consLookback = params.consolidationLookback.value;
      const consThreshold = params.consolidationAtrThreshold.value;

      let last4hIdx = -1;
      for (let j = htf4hRef.length - 1; j >= 0; j--) {
        if (htf4hRef[j].t + MS_4H <= currentCandle.t) {
          last4hIdx = j;
          break;
        }
      }
      if (last4hIdx < consLookback) return null;

      const atr4h = htfAtr4h[last4hIdx];
      if (isNaN(atr4h)) return null;

      let rangeHigh4h = -Infinity;
      let rangeLow4h = Infinity;
      for (let j = last4hIdx - consLookback + 1; j <= last4hIdx; j++) {
        rangeHigh4h = Math.max(rangeHigh4h, htf4hRef[j].h);
        rangeLow4h = Math.min(rangeLow4h, htf4hRef[j].l);
      }
      const htfRange = rangeHigh4h - rangeLow4h;
      const consThresholdAbs = consThreshold * atr4h;

      // Volume SMA(20)
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;

      // Diagnostics
      ctx.indicator("dcUpper", dcUpper);
      ctx.indicator("dcLower", dcLower);
      ctx.indicator("close", close);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("atr4h", atr4h);
      ctx.indicator("htfRange4h", htfRange);
      ctx.indicator("consThresholdAbs", consThresholdAbs);
      ctx.indicator("volAvg20", volAvg20);

      // LONG: close above Donchian upper + 4H consolidation + volume spike
      const longBreakout = ctx.track("L:close_above_dc", close > dcUpper, close, dcUpper);
      const longConsol = ctx.track("L:4h_consolidation", htfRange < consThresholdAbs, htfRange, consThresholdAbs);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreakout && longConsol && longVol) {
        const sl = close - stopDist;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "Donchian breakout long",
        };
      }

      // SHORT: close below Donchian lower + 4H consolidation + volume spike
      const shortBreakout = ctx.track("S:close_below_dc", close < dcLower, close, dcLower);
      const shortConsol = ctx.track("S:4h_consolidation", htfRange < consThresholdAbs, htfRange, consThresholdAbs);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreakout && shortConsol && shortVol) {
        const sl = close + stopDist;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "Donchian breakout short",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, currentCandle, candles, positionDirection, positionEntryBarIndex, positionEntryPrice, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      // Timeout first (mandatory)
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
      const { index, currentCandle, candles, positionDirection, positionEntryBarIndex, positionEntryPrice, higherTimeframes } = ctx;
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
