import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { ema } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { macd } from "../../../indicators/macd.js";
import { donchian } from "../../../indicators/donchian.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

const EMA_PERIOD = 50;
const RETEST_TOLERANCE = 1.0;
const RETEST_INVALIDATION = 1.5;

interface RangeRetestEmaMacdTrailDcParams {
  rangeLookback: StrategyParam;
  rangeAtrThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  retestWindow: StrategyParam;
  atrStopMult: StrategyParam;
  dcTrailPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: RangeRetestEmaMacdTrailDcParams = {
  rangeLookback: {
    value: 30, min: 10, max: 40, step: 5, optimizable: true,
    description: "Bars to look back for range high/low definition",
  },
  rangeAtrThreshold: {
    value: 4, min: 3, max: 10, step: 0.5, optimizable: true,
    description: "Max range width as multiple of ATR(14) 15m — below = consolidation",
  },
  volMultiplier: {
    value: 3, min: 1, max: 3, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  retestWindow: {
    value: 20, min: 8, max: 28, step: 2, optimizable: true,
    description: "Bars to wait for retest after initial breakout",
  },
  atrStopMult: {
    value: 3, min: 3, max: 6, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  dcTrailPeriod: {
    value: 12, min: 6, max: 24, step: 2, optimizable: true,
    description: "Fast Donchian channel period for trailing exit",
  },
  timeoutBars: {
    value: 72, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createRangeRetestEmaMacdTrailDc(
  paramOverrides?: Partial<Record<keyof RangeRetestEmaMacdTrailDcParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof RangeRetestEmaMacdTrailDcParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let atr15mCache: number[] | null = null;
  let volSmaCache: number[] | null = null;
  let macdHistCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htf4hEmaCache: number[] | null = null;
  let dcExitCache: { upper: number[]; lower: number[] } | null = null;

  let pendingRetest: {
    direction: "long" | "short";
    level: number;
    breakoutBar: number;
    atr1hAtBreakout: number;
  } | null = null;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function find4hEma(currentT: number, htfRef: Candle[], htfEma: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT && !isNaN(htfEma[j])) {
        return htfEma[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Range Retest EMA MACD Trail-DC",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 60 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      atr15mCache = atr(candles, 14);
      volSmaCache = sma(candles.map(c => c.v), 20);
      const closes = candles.map(c => c.c);
      const macdResult = macd(closes, 12, 26, 9);
      macdHistCache = macdResult.histogram;
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htf4hEmaCache = htf4hCandles.length > 0
        ? ema(htf4hCandles.map(c => c.c), EMA_PERIOD)
        : null;
      const dcPeriod = Math.round(params.dcTrailPeriod.value);
      dcExitCache = donchian(candles, dcPeriod);
      pendingRetest = null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const lookback = Math.round(params.rangeLookback.value);
      if (index < lookback + 26) return null;

      if (ctx.positionDirection) {
        pendingRetest = null;
        return null;
      }

      const atr15mVal = atr15mCache ? atr15mCache[index] : NaN;
      if (isNaN(atr15mVal) || atr15mVal <= 0) return null;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1h)) return null;

      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < EMA_PERIOD + 1) return null;
      const ema4h = htf4hEmaCache ?? ema(htf4hRef.map(c => c.c), EMA_PERIOD);
      const ema4hVal = find4hEma(currentCandle.t, htf4hRef, ema4h);
      if (isNaN(ema4hVal)) return null;

      const macdHist = macdHistCache ? macdHistCache[index] : NaN;
      const volSma = volSmaCache ? volSmaCache[index] : NaN;
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volSma) ? volMult * volSma : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const retestWin = Math.round(params.retestWindow.value);

      ctx.indicator("atr15m", atr15mVal);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("ema4h", ema4hVal);
      ctx.indicator("macdHist", macdHist);
      ctx.indicator("volSma20", volSma);

      // === PHASE 2: Check pending retest ===
      if (pendingRetest) {
        const barsSinceBreakout = index - pendingRetest.breakoutBar;
        ctx.indicator("retestBarsWaiting", barsSinceBreakout);

        if (barsSinceBreakout > retestWin) {
          pendingRetest = null;
        } else {
          const level = pendingRetest.level;
          const dir = pendingRetest.direction;
          const atr1hBk = pendingRetest.atr1hAtBreakout;
          const stopDist = atr1hBk * stopMult;

          if (dir === "long") {
            const retestZone = level + RETEST_TOLERANCE * atr1hBk;
            const retestApproach = ctx.track("L:retest_approach", currentCandle.l <= retestZone, currentCandle.l, retestZone);
            const retestHold = ctx.track("L:retest_hold", close > level, close, level);

            if (retestApproach && retestHold) {
              pendingRetest = null;
              return {
                direction: "long",
                entryPrice: null,
                stopLoss: close - stopDist,
                takeProfits: [],
                comment: "Range retest long (EMA+MACD+Trail-DC)",
              };
            }

            if (close < level - RETEST_INVALIDATION * atr1hBk) {
              pendingRetest = null;
            } else {
              return null;
            }
          } else {
            const retestZone = level - RETEST_TOLERANCE * atr1hBk;
            const retestApproach = ctx.track("S:retest_approach", currentCandle.h >= retestZone, currentCandle.h, retestZone);
            const retestHold = ctx.track("S:retest_hold", close < level, close, level);

            if (retestApproach && retestHold) {
              pendingRetest = null;
              return {
                direction: "short",
                entryPrice: null,
                stopLoss: close + stopDist,
                takeProfits: [],
                comment: "Range retest short (EMA+MACD+Trail-DC)",
              };
            }

            if (close > level + RETEST_INVALIDATION * atr1hBk) {
              pendingRetest = null;
            } else {
              return null;
            }
          }
        }
      }

      // === PHASE 1: Detect breakouts (set pending retest) ===
      let rangeHigh = -Infinity;
      let rangeLow = Infinity;
      for (let k = index - lookback; k < index; k++) {
        if (candles[k].h > rangeHigh) rangeHigh = candles[k].h;
        if (candles[k].l < rangeLow) rangeLow = candles[k].l;
      }
      const rangeWidth = rangeHigh - rangeLow;
      const normalizedWidth = rangeWidth / atr15mVal;
      const threshold = params.rangeAtrThreshold.value;
      const isConsolidated = normalizedWidth < threshold;

      ctx.indicator("rangeHigh", rangeHigh);
      ctx.indicator("rangeLow", rangeLow);
      ctx.indicator("normalizedWidth", normalizedWidth);

      // Long breakout — MACD confirmed at breakout time (not at retest)
      const longConsolidation = ctx.track("L:consolidated", isConsolidated, normalizedWidth, threshold);
      const longBreakout = ctx.track("L:close_above_range", close > rangeHigh, close, rangeHigh);
      const longRegime = ctx.track("L:above_ema4h", close > ema4hVal, close, ema4hVal);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);
      const longMacd = ctx.track("L:macd_positive", !isNaN(macdHist) && macdHist > 0, macdHist, 0);

      if (longConsolidation && longBreakout && longRegime && longVol && longMacd) {
        pendingRetest = {
          direction: "long",
          level: rangeHigh,
          breakoutBar: index,
          atr1hAtBreakout: atr1h,
        };
        return null;
      }

      // Short breakout — MACD confirmed at breakout time (not at retest)
      const shortConsolidation = ctx.track("S:consolidated", isConsolidated, normalizedWidth, threshold);
      const shortBreakout = ctx.track("S:close_below_range", close < rangeLow, close, rangeLow);
      const shortRegime = ctx.track("S:below_ema4h", close < ema4hVal, close, ema4hVal);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);
      const shortMacd = ctx.track("S:macd_negative", !isNaN(macdHist) && macdHist < 0, macdHist, 0);

      if (shortConsolidation && shortBreakout && shortRegime && shortVol && shortMacd) {
        pendingRetest = {
          direction: "short",
          level: rangeLow,
          breakoutBar: index,
          atr1hAtBreakout: atr1h,
        };
        return null;
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Donchian trailing channel exit
      const dc = dcExitCache;
      if (!dc || index < 2) return null;

      if (positionDirection === "long") {
        const trailLevel = dc.lower[index - 1];
        ctx.indicator("trailDcLevel", isNaN(trailLevel) ? 0 : trailLevel);
        if (!isNaN(trailLevel) && currentCandle.c < trailLevel) {
          return { exit: true, comment: "Trail DC" };
        }
      } else {
        const trailLevel = dc.upper[index - 1];
        ctx.indicator("trailDcLevel", isNaN(trailLevel) ? 0 : trailLevel);
        if (!isNaN(trailLevel) && currentCandle.c > trailLevel) {
          return { exit: true, comment: "Trail DC" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const dc = dcExitCache;
      if (!dc || index < 2) return null;

      if (positionDirection === "long") {
        const level = dc.lower[index - 1];
        return isNaN(level) ? null : level;
      } else {
        const level = dc.upper[index - 1];
        return isNaN(level) ? null : level;
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
        return {
          stopLoss: close - stopDist,
          takeProfits: [],
        };
      } else {
        return {
          stopLoss: close + stopDist,
          takeProfits: [],
        };
      }
    },
  };
}
