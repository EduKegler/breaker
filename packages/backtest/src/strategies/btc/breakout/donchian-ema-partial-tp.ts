import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { donchian } from "../../../indicators/donchian.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;
const TP1_PCT = 0.35;
const TP2_PCT = 0.35;

interface DonchianEmaPartialTpParams {
  donchianPeriod: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  tp1RR: StrategyParam;
  tp2RR: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: DonchianEmaPartialTpParams = {
  donchianPeriod: {
    value: 20, min: 14, max: 40, step: 2, optimizable: true,
    description: "Donchian Channel lookback period (N-bar high/low)",
  },
  volMultiplier: {
    value: 2, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
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

export function createDonchianEmaPartialTp(
  paramOverrides?: Partial<Record<keyof DonchianEmaPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof DonchianEmaPartialTpParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let dcCache: { upper: number[]; lower: number[]; mid: number[] } | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfEmaCache1d: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf1dCandles: Candle[] | null = null;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function findDailyEma(currentT: number, htfRef: Candle[], htfEma: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1D <= currentT && !isNaN(htfEma[j])) {
        return htfEma[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Donchian EMA Timeout",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 50, "1h": 15, "1d": 210 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      dcCache = donchian(candles, params.donchianPeriod.value);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf1dCandles = higherTimeframes["1d"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfEmaCache1d = htf1dCandles.length > 0 ? ema(htf1dCandles.map(c => c.c), 200) : null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const period = params.donchianPeriod.value;
      if (index < period + 5) return null;

      // Donchian levels from previous bar (candle close confirmation — Rule 4)
      const dc = dcCache ?? donchian(candles.slice(0, index + 1), period);
      const dcUpper = dc.upper[index - 1];
      const dcLower = dc.lower[index - 1];
      if (isNaN(dcUpper) || isNaN(dcLower)) return null;

      // 1H ATR — only completed bars (anti-repaint)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

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
      ctx.indicator("dailyEma200", dailyEma200);
      ctx.indicator("dailyClose", dailyClose);
      ctx.indicator("volAvg20", volAvg20);

      // LONG: close above Donchian upper + Daily above EMA(200) + volume spike
      const longBreakout = ctx.track("L:close_above_dc", close > dcUpper, close, dcUpper);
      const longRegime = ctx.track("L:daily_above_ema", dailyClose > dailyEma200, dailyClose, dailyEma200);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreakout && longRegime && longVol) {
        const sl = close - stopDist;
        const risk = stopDist;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [
            { price: close + params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close + params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
          comment: "Donchian breakout long (EMA regime)",
        };
      }

      // SHORT: close below Donchian lower + Daily below EMA(200) + volume spike
      const shortBreakout = ctx.track("S:close_below_dc", close < dcLower, close, dcLower);
      const shortRegime = ctx.track("S:daily_below_ema", dailyClose < dailyEma200, dailyClose, dailyEma200);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreakout && shortRegime && shortVol) {
        const sl = close + stopDist;
        const risk = stopDist;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [
            { price: close - params.tp1RR.value * risk, pctOfPosition: TP1_PCT },
            { price: close - params.tp2RR.value * risk, pctOfPosition: TP2_PCT },
          ],
          comment: "Donchian breakout short (EMA regime)",
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
