import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { donchian } from "../../../indicators/donchian.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

interface ExpansionEmaTrailDcParams {
  expansionMult: StrategyParam;
  emaPeriod: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  trailDcPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: ExpansionEmaTrailDcParams = {
  expansionMult: {
    value: 1.3, min: 1.1, max: 2.0, step: 0.1, optimizable: true,
    description: "ATR spike threshold: current ATR(14) > X * SMA(ATR,20)",
  },
  emaPeriod: {
    value: 100, min: 20, max: 100, step: 10, optimizable: true,
    description: "Daily EMA period for regime direction filter",
  },
  volMultiplier: {
    value: 1.25, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  trailDcPeriod: {
    value: 20, min: 5, max: 20, step: 1, optimizable: true,
    description: "Fast Donchian channel period for trailing exit",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createExpansionEmaTrailDc(
  paramOverrides?: Partial<Record<keyof ExpansionEmaTrailDcParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof ExpansionEmaTrailDcParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let atrSmaCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htfDailyCandles: Candle[] | null = null;
  let htfDailyEmaCache: number[] | null = null;
  let dcCache: { upper: number[]; lower: number[]; mid: number[] } | null = null;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function findDailyEma(currentT: number, dailyRef: Candle[], dailyEma: number[]): number {
    for (let j = dailyRef.length - 1; j >= 0; j--) {
      if (dailyRef[j].t + MS_1D <= currentT && !isNaN(dailyEma[j])) {
        return dailyEma[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Expansion EMA Trail DC",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 50, "1h": 15, "1d": 60 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      atrSmaCache = sma(atr15mCache, 20);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfDailyCandles = higherTimeframes["1d"] ?? [];
      htfDailyEmaCache = htfDailyCandles.length > 0
        ? ema(htfDailyCandles.map(c => c.c), params.emaPeriod.value)
        : null;
      dcCache = donchian(candles, params.trailDcPeriod.value);
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 35) return null;

      // --- 15m ATR expansion detection ---
      const atr15m = atr15mCache ?? atr(candles, 14);
      const atrSma20 = atrSmaCache ?? sma(atr15m, 20);
      const currentAtr = atr15m[index];
      const avgAtr = atrSma20[index];
      if (isNaN(currentAtr) || isNaN(avgAtr) || avgAtr <= 0) return null;

      const expansionLevel = params.expansionMult.value * avgAtr;

      // --- HTF: 1H ATR for stop (anti-repaint: completed bar only) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1hVal)) return null;

      // --- HTF: Daily EMA regime filter (anti-repaint: completed bar only) ---
      const dailyRef = htfDailyCandles ?? higherTimeframes["1d"];
      if (!dailyRef || dailyRef.length < 10) return null;
      const dailyEma = htfDailyEmaCache ?? ema(dailyRef.map(c => c.c), params.emaPeriod.value);
      const emaVal = findDailyEma(currentCandle.t, dailyRef, dailyEma);
      if (isNaN(emaVal)) return null;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const prevCandle = candles[index - 1];
      const stopDist = atr1hVal * params.atrStopMult.value;

      // --- Diagnostics ---
      ctx.indicator("atr15m", currentAtr);
      ctx.indicator("avgAtr20", avgAtr);
      ctx.indicator("expansionLevel", expansionLevel);
      ctx.indicator("dailyEma", emaVal);
      ctx.indicator("atr1h", atr1hVal);
      ctx.indicator("volAvg20", volAvg20);

      // --- LONG: expansion + price above EMA (uptrend) + close above prev high + volume ---
      const longExpansion = ctx.track("L:atr_expansion", currentAtr > expansionLevel, currentAtr, expansionLevel);
      const longRegime = ctx.track("L:ema_uptrend", close > emaVal, close, emaVal);
      const longBreakout = ctx.track("L:close_above_prev_high", close > prevCandle.h, close, prevCandle.h);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longExpansion && longRegime && longBreakout && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Expansion long (EMA uptrend)",
        };
      }

      // --- SHORT: expansion + price below EMA (downtrend) + close below prev low + volume ---
      const shortExpansion = ctx.track("S:atr_expansion", currentAtr > expansionLevel, currentAtr, expansionLevel);
      const shortRegime = ctx.track("S:ema_downtrend", close < emaVal, close, emaVal);
      const shortBreakout = ctx.track("S:close_below_prev_low", close < prevCandle.l, close, prevCandle.l);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortExpansion && shortRegime && shortBreakout && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Expansion short (EMA downtrend)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, currentCandle, candles, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Donchian trailing exit (use previous bar's channel to avoid lookahead)
      if (index < 1) return null;
      const dc = dcCache ?? donchian(candles, params.trailDcPeriod.value);
      const prevDcLower = dc.lower[index - 1];
      const prevDcUpper = dc.upper[index - 1];

      if (positionDirection === "long" && !isNaN(prevDcLower)) {
        if (currentCandle.c < prevDcLower) {
          return { exit: true, comment: "Trail DC" };
        }
      } else if (positionDirection === "short" && !isNaN(prevDcUpper)) {
        if (currentCandle.c > prevDcUpper) {
          return { exit: true, comment: "Trail DC" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, candles, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const dc = dcCache ?? donchian(candles, params.trailDcPeriod.value);

      if (positionDirection === "long") {
        const level = dc.lower[index];
        return isNaN(level) ? null : level;
      } else {
        const level = dc.upper[index];
        return isNaN(level) ? null : level;
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
