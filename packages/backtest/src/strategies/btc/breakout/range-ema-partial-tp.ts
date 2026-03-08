import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema as emaIndicator } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

interface RangeEmaPartialTpParams {
  rangePeriod: StrategyParam;
  rangeWidthThreshold: StrategyParam;
  emaPeriod: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeEmaPartialTpParams = {
  rangePeriod: { value: 15, min: 10, max: 30, step: 5, optimizable: true, description: "Bars to define the consolidation range" },
  rangeWidthThreshold: { value: 2.0, min: 1.0, max: 3.0, step: 0.25, optimizable: true, description: "Max ATR-normalized bar width for range qualification" },
  emaPeriod: { value: 50, min: 20, max: 100, step: 10, optimizable: true, description: "Daily EMA period for regime filter" },
  volMultiplier: { value: 2.0, min: 1.0, max: 3.0, step: 0.25, optimizable: true, description: "Volume spike threshold (X * SMA20 volume)" },
  atrStopMult: { value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true, description: "ATR(14) 1H initial stop multiplier (KB §1.6 >= 3.0)" },
  atrTrailMult: { value: 3.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true, description: "ATR(14) 1H trailing stop multiplier" },
  timeoutBars: { value: 48, min: 24, max: 96, step: 4, optimizable: true, description: "Forced exit after N bars to prevent funding bleed" },
};

export function createRangeEmaPartialTp(
  paramOverrides?: Partial<Record<keyof RangeEmaPartialTpParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeEmaPartialTpParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf1dCandles: Candle[] | null = null;
  let htf1dEmaCache: number[] | null = null;

  return {
    name: "BTC 15m Breakout — Range EMA Partial-TP",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 50, "1h": 15, "1d": 120 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);

      const volumes = candles.map(c => c.v);
      volSmaCache = sma(volumes, 20);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache = atr(htf1hCandles, 14);
      }

      htf1dCandles = higherTimeframes["1d"] ?? [];
      if (htf1dCandles.length > 0) {
        const dailyCloses = htf1dCandles.map(c => c.c);
        htf1dEmaCache = emaIndicator(dailyCloses, params.emaPeriod.value);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const rangePeriod = params.rangePeriod.value;
      if (index < rangePeriod + 14) return null;

      // ATR(14) on 15m for range width normalization
      const atr15m = atr15mCache ?? atr(candles.slice(0, index + 1), 14);
      const currentAtr15m = atr15m[index];
      if (isNaN(currentAtr15m) || currentAtr15m === 0) return null;

      // Check if last rangePeriod bars form a narrow range
      const rangeThreshold = params.rangeWidthThreshold.value;
      let rangeHigh = -Infinity;
      let rangeLow = Infinity;
      let allNarrow = true;

      for (let i = index - rangePeriod; i < index; i++) {
        const bar = candles[i];
        const barAtr = atr15m[i];
        if (isNaN(barAtr) || barAtr === 0) { allNarrow = false; break; }
        const barWidth = (bar.h - bar.l) / barAtr;
        if (barWidth >= rangeThreshold) { allNarrow = false; break; }
        if (bar.h > rangeHigh) rangeHigh = bar.h;
        if (bar.l < rangeLow) rangeLow = bar.l;
      }

      // Volume SMA(20)
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];

      // 1H ATR — only completed bars (anti-repaint)
      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      // Daily EMA — only completed bars (anti-repaint)
      const htf1dRef = htf1dCandles ?? higherTimeframes["1d"];
      if (!htf1dRef || htf1dRef.length < params.emaPeriod.value) return null;
      const dailyEma = htf1dEmaCache ?? emaIndicator(htf1dRef.map(c => c.c), params.emaPeriod.value);
      let emaValue = NaN;
      let dailyClose = NaN;
      for (let j = htf1dRef.length - 1; j >= 0; j--) {
        if (htf1dRef[j].t + MS_1D <= currentCandle.t && !isNaN(dailyEma[j])) {
          emaValue = dailyEma[j];
          dailyClose = htf1dRef[j].c;
          break;
        }
      }
      if (isNaN(emaValue)) return null;

      const close = currentCandle.c;
      const volMult = params.volMultiplier.value;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      ctx.indicator("close", close);
      ctx.indicator("rangeHigh", rangeHigh === -Infinity ? NaN : rangeHigh);
      ctx.indicator("rangeLow", rangeLow === Infinity ? NaN : rangeLow);
      ctx.indicator("atr15m", currentAtr15m);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("dailyEma", emaValue);
      ctx.indicator("dailyClose", dailyClose);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("rangeNarrow", allNarrow ? 1 : 0);

      // LONG: narrow range + close above range high + daily close above EMA + volume spike
      const longRange = ctx.track("L:range_narrow", allNarrow);
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longRegime = ctx.track("L:above_daily_ema", dailyClose > emaValue, dailyClose, emaValue);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longRange && longBreakout && longRegime && longVol) {
        const sl = close - stopDist;
        const tpPrice = close + 1.5 * stopDist;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [{ price: tpPrice, pctOfPosition: 0.5 }],
          comment: "Range breakout long",
        };
      }

      // SHORT: narrow range + close below range low + daily close below EMA + volume spike
      const shortRange = ctx.track("S:range_narrow", allNarrow);
      const shortBreakout = ctx.track("S:close_below_range", close < rangeLow, close, rangeLow);
      const shortRegime = ctx.track("S:below_daily_ema", dailyClose < emaValue, dailyClose, emaValue);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortRange && shortBreakout && shortRegime && shortVol) {
        const sl = close + stopDist;
        const tpPrice = close - 1.5 * stopDist;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [{ price: tpPrice, pctOfPosition: 0.5 }],
          comment: "Range breakout short",
        };
      }

      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      const stopMult = params.atrStopMult.value;
      const close = currentCandle.c;
      const stopDist = atr1h * stopMult;

      if (direction === "long") {
        const sl = close - stopDist;
        const tpPrice = close + 1.5 * stopDist;
        return { stopLoss: sl, takeProfits: [{ price: tpPrice, pctOfPosition: 0.5 }] };
      } else {
        const sl = close + stopDist;
        const tpPrice = close - 1.5 * stopDist;
        return { stopLoss: sl, takeProfits: [{ price: tpPrice, pctOfPosition: 0.5 }] };
      }
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      // Timeout check first (mandatory)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // ATR trailing stop
      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      const trailDist = atr1h * params.atrTrailMult.value;
      const close = currentCandle.c;

      if (positionDirection === "long") {
        let highestSinceEntry = positionEntryPrice;
        for (let i = positionEntryBarIndex; i <= index; i++) {
          if (candles[i].h > highestSinceEntry) highestSinceEntry = candles[i].h;
        }
        const trailStop = highestSinceEntry - trailDist;
        if (close < trailStop) {
          return { exit: true, comment: "ATR trail stop" };
        }
      } else {
        let lowestSinceEntry = positionEntryPrice;
        for (let i = positionEntryBarIndex; i <= index; i++) {
          if (candles[i].l < lowestSinceEntry) lowestSinceEntry = candles[i].l;
        }
        const trailStop = lowestSinceEntry + trailDist;
        if (close > trailStop) {
          return { exit: true, comment: "ATR trail stop" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      const trailDist = atr1h * params.atrTrailMult.value;

      if (positionDirection === "long") {
        let highestSinceEntry = positionEntryPrice;
        for (let i = positionEntryBarIndex; i <= index; i++) {
          if (candles[i].h > highestSinceEntry) highestSinceEntry = candles[i].h;
        }
        return highestSinceEntry - trailDist;
      } else {
        let lowestSinceEntry = positionEntryPrice;
        for (let i = positionEntryBarIndex; i <= index; i++) {
          if (candles[i].l < lowestSinceEntry) lowestSinceEntry = candles[i].l;
        }
        return lowestSinceEntry + trailDist;
      }
    },
  };
}
