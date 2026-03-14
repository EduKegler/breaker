import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import { donchian, type DonchianResult } from "../../../indicators/donchian.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";
import { ema } from "../../../indicators/ema.js";

const MS_1D = 86_400_000;

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

interface DonchianDailyEmaSlopeAtrTrailParams {
  donchianPeriod: StrategyParam;
  emaPeriod: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: DonchianDailyEmaSlopeAtrTrailParams = {
  donchianPeriod: {
    value: 20,
    min: 15,
    max: 50,
    step: 5,
    optimizable: true,
    description: "Donchian channel lookback period on Daily",
  },
  emaPeriod: {
    value: 100,
    min: 50,
    max: 200,
    step: 25,
    optimizable: true,
    description: "EMA period for regime filter on Daily",
  },
  adxThreshold: {
    value: 25,
    min: 25,
    max: 35,
    step: 1,
    optimizable: true,
    description: "ADX(14) Daily threshold — trend confirmed above this (KB floor: 25)",
  },
  atrStopMult: {
    value: 3.5,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  atrTrailMult: {
    value: 3.0,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "ATR trailing stop multiplier using Daily ATR",
  },
  timeoutBars: {
    value: 120,
    min: 60,
    max: 180,
    step: 6,
    optimizable: true,
    description: "Forced exit after N 4H bars (120 = 20 days)",
  },
};

export function createDonchianDailyEmaSlopeAtrTrail(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let dcCache: DonchianResult | null = null;
  let dailyEmaCache: number[] | null = null;
  let dailyAdxCache: AdxResult | null = null;
  let dailyAtrCache: number[] | null = null;
  let dailyCandlesRef: Candle[] | null = null;

  /** Find index of last fully-closed Daily candle (anti-lookahead). */
  function findLastDailyIdx(currentT: number, dailyRef: Candle[]): number {
    for (let j = dailyRef.length - 1; j >= 0; j--) {
      if (dailyRef[j].t + MS_1D <= currentT) {
        return j;
      }
    }
    return -1;
  }

  /** Find last completed Daily indicator value (anti-lookahead). */
  function findDailyValue(
    currentT: number,
    dailyRef: Candle[],
    values: number[],
  ): number {
    for (let j = dailyRef.length - 1; j >= 0; j--) {
      if (dailyRef[j].t + MS_1D <= currentT && !isNaN(values[j])) {
        return values[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 4H Trend Following — Donchian Daily EMA Slope ATR Trail",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 10, "1d": 220 },

    init(_candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        dcCache = donchian(dailyCandlesRef, params.donchianPeriod.value);
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyEmaCache = ema(dailyCloses, params.emaPeriod.value);
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, higherTimeframes: htf } = ctx;

      // ── Daily data ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 28) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 2) return null;

      // ── Donchian on Daily (breakout detection) ──
      const dc = dcCache ?? donchian(dCandles, params.donchianPeriod.value);
      const dcUpperRef = dc.upper[dIdx - 1];
      const dcLowerRef = dc.lower[dIdx - 1];
      const dcUpperPrev = dc.upper[dIdx - 2];
      const dcLowerPrev = dc.lower[dIdx - 2];
      if (
        isNaN(dcUpperRef) ||
        isNaN(dcLowerRef) ||
        isNaN(dcUpperPrev) ||
        isNaN(dcLowerPrev)
      ) {
        return null;
      }

      const latestDailyClose = dCandles[dIdx].c;
      const prevDailyClose = dCandles[dIdx - 1].c;

      // ── EMA regime filter on Daily ──
      const emaVals =
        dailyEmaCache ?? ema(dCandles.map((c) => c.c), params.emaPeriod.value);
      const emaVal = emaVals[dIdx];
      if (isNaN(emaVal)) return null;

      // ── Daily ADX (completed bar only) ──
      const dAdx = dailyAdxCache ?? adxIndicator(dCandles, 14);
      const adxVal = findDailyValue(currentCandle.t, dCandles, dAdx.adx);
      if (isNaN(adxVal)) return null;

      // ── Daily ATR for initial stop ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const adxThresh = params.adxThreshold.value;
      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("dcUpper", dcUpperRef);
      ctx.indicator("dcLower", dcLowerRef);
      ctx.indicator("dailyClose", latestDailyClose);
      ctx.indicator("dailyEma", emaVal);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);

      // ── LONG: Daily close broke above Donchian upper + price above EMA + ADX ──
      const longBreakout = ctx.track(
        "L:dc_breakout",
        latestDailyClose > dcUpperRef && prevDailyClose <= dcUpperPrev,
        latestDailyClose,
        dcUpperRef,
      );
      const longRegime = ctx.track(
        "L:ema_regime",
        latestDailyClose > emaVal,
        latestDailyClose,
        emaVal,
      );
      const longAdx = ctx.track(
        "L:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (longBreakout && longRegime && longAdx) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Donchian Daily breakout long (EMA regime + ADX confirmed)",
        };
      }

      // ── SHORT: Daily close broke below Donchian lower + price below EMA + ADX ──
      const shortBreakout = ctx.track(
        "S:dc_breakdown",
        latestDailyClose < dcLowerRef && prevDailyClose >= dcLowerPrev,
        latestDailyClose,
        dcLowerRef,
      );
      const shortRegime = ctx.track(
        "S:ema_regime",
        latestDailyClose < emaVal,
        latestDailyClose,
        emaVal,
      );
      const shortAdx = ctx.track(
        "S:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (shortBreakout && shortRegime && shortAdx) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Donchian Daily breakdown short (EMA regime + ADX confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const {
        candles,
        index,
        currentCandle,
        positionDirection,
        positionEntryBarIndex,
        positionEntryPrice,
      } = ctx;
      if (
        !positionDirection ||
        positionEntryBarIndex === null ||
        positionEntryPrice === null
      ) {
        return null;
      }

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB §6)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Trailing exit blocked during minimum hold (KB §9)
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // ── ATR trailing stop ──
      const dCandles = dailyCandlesRef ?? ctx.higherTimeframes["1d"];
      if (!dCandles || dCandles.length < 15) return null;
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const trailDist = params.atrTrailMult.value * atrVal;

      if (positionDirection === "long") {
        let highestHigh = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].h > highestHigh) highestHigh = candles[k].h;
        }
        const trailStop = highestHigh - trailDist;
        if (currentCandle.c < trailStop) {
          return { exit: true, comment: "ATR Trail (long)" };
        }
      }

      if (positionDirection === "short") {
        let lowestLow = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].l < lowestLow) lowestLow = candles[k].l;
        }
        const trailStop = lowestLow + trailDist;
        if (currentCandle.c > trailStop) {
          return { exit: true, comment: "ATR Trail (short)" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const {
        candles,
        index,
        currentCandle,
        positionDirection,
        positionEntryBarIndex,
        positionEntryPrice,
      } = ctx;
      if (
        !positionDirection ||
        positionEntryBarIndex === null ||
        positionEntryPrice === null
      ) {
        return null;
      }

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const dCandles = dailyCandlesRef ?? ctx.higherTimeframes["1d"];
      if (!dCandles || dCandles.length < 15) return null;
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const trailDist = params.atrTrailMult.value * atrVal;

      if (positionDirection === "long") {
        let highestHigh = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].h > highestHigh) highestHigh = candles[k].h;
        }
        return highestHigh - trailDist;
      }

      if (positionDirection === "short") {
        let lowestLow = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].l < lowestLow) lowestLow = candles[k].l;
        }
        return lowestLow + trailDist;
      }

      return null;
    },

    computeLevels(
      ctx: StrategyContext,
      direction: "long" | "short",
    ): {
      stopLoss: number;
      takeProfits: { price: number; pctOfPosition: number }[];
    } | null {
      const { currentCandle, higherTimeframes: htf } = ctx;

      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 15) return null;
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const stopDist = atrVal * params.atrStopMult.value;
      const close = currentCandle.c;

      return {
        stopLoss: direction === "long" ? close - stopDist : close + stopDist,
        takeProfits: [],
      };
    },
  };
}
