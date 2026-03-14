import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import {
  macd as macdIndicator,
  type MacdResult,
} from "../../../indicators/macd.js";
import {
  chandelier as chandelierIndicator,
  type ChandelierResult,
} from "../../../indicators/chandelier.js";
import { ema } from "../../../indicators/ema.js";
import { slope } from "../../../indicators/slope.js";
import { atr } from "../../../indicators/atr.js";

const MS_1D = 86_400_000;

/**
 * Minimum hold period (KB rule 9, hard floor: 3 bars = 12h on 4H).
 * Trailing exit (Chandelier) blocked during this period.
 * Hard SL and timeout are exempt.
 */
const MIN_HOLD_BARS = 3;

/** Fixed MACD signal period (standard 9). Not optimizable — saves a var slot. */
const MACD_SIGNAL_PERIOD = 9;

/** Fixed Chandelier lookback period (standard 22 bars on 4H = ~3.7 days). Saves a var slot. */
const CHANDELIER_PERIOD = 22;

interface LongMacdHtfEmaSlopeChandelierParams {
  macdFast: StrategyParam;
  macdSlow: StrategyParam;
  emaPeriod: StrategyParam;
  atrStopMult: StrategyParam;
  chandelierMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: LongMacdHtfEmaSlopeChandelierParams = {
  macdFast: {
    value: 12,
    min: 8,
    max: 16,
    step: 2,
    optimizable: true,
    description: "MACD fast EMA period on 4H",
  },
  macdSlow: {
    value: 30,
    min: 20,
    max: 34,
    step: 2,
    optimizable: true,
    description: "MACD slow EMA period on 4H",
  },
  emaPeriod: {
    value: 50,
    min: 10,
    max: 50,
    step: 5,
    optimizable: true,
    description: "Daily EMA period for slope regime filter",
  },
  atrStopMult: {
    value: 3.5,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  chandelierMult: {
    value: 3.0,
    min: 2.0,
    max: 5.0,
    step: 0.5,
    optimizable: true,
    description:
      "Chandelier ATR multiplier for trailing exit on 4H (period=22 fixed)",
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

export function createLongMacdHtfEmaSlopeChandelier(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let macdCache: MacdResult | null = null;
  let chandelierCache: ChandelierResult | null = null;
  let dailyEmaCache: number[] | null = null;
  let dailyEmaSlopeCache: number[] | null = null;
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

  return {
    name: "BTC 4H Trend Following — Long MACD HTF EMA Slope Chandelier",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 80, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes4h = candles.map((c) => c.c);

      // MACD on 4H source candles
      macdCache = macdIndicator(
        closes4h,
        params.macdFast.value,
        params.macdSlow.value,
        MACD_SIGNAL_PERIOD,
      );

      // Chandelier Exit on 4H for trailing exit
      chandelierCache = chandelierIndicator(
        candles,
        CHANDELIER_PERIOD,
        params.chandelierMult.value,
      );

      // Daily indicators (EMA slope + ATR)
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyEmaCache = ema(dailyCloses, params.emaPeriod.value);
        dailyEmaSlopeCache = slope(dailyEmaCache, 1);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, index, higherTimeframes: htf } = ctx;

      // Warmup: MACD needs ~43 bars (slow 34 + signal 9), use 80 for margin
      if (index < 80) return null;

      // ── MACD on 4H (cached from init) ──
      const m = macdCache;
      if (!m) return null;

      const currMacd = m.macd[index];
      const currSignal = m.signal[index];
      const prevMacd = m.macd[index - 1];
      const prevSignal = m.signal[index - 1];

      if (
        isNaN(currMacd) ||
        isNaN(currSignal) ||
        isNaN(prevMacd) ||
        isNaN(prevSignal)
      ) {
        return null;
      }

      // ── Daily candles — anti-lookahead ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 15) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 14) return null;

      // ── Daily EMA slope regime filter ──
      const dEma = dailyEmaCache ?? ema(
        dCandles.map((c) => c.c),
        params.emaPeriod.value,
      );
      const emaVal = dEma[dIdx];
      if (isNaN(emaVal)) return null;

      const dSlope = dailyEmaSlopeCache ?? slope(dEma, 1);
      const slopeVal = dSlope[dIdx];
      if (isNaN(slopeVal)) return null;

      // ── Daily ATR for hard SL ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = dAtr[dIdx];
      if (isNaN(atrVal)) return null;

      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("macdLine", currMacd);
      ctx.indicator("macdSignal", currSignal);
      ctx.indicator("macdHist", currMacd - currSignal);
      ctx.indicator("emaDaily", emaVal);
      ctx.indicator("emaSlopeDaily", slopeVal);
      ctx.indicator("atrDaily", atrVal);
      ctx.indicator("minHoldBars", MIN_HOLD_BARS);

      // ── LONG ONLY: MACD bullish crossover on 4H + EMA slope regime confirms uptrend ──
      const longCross = ctx.track(
        "L:macd_cross_bull",
        prevMacd <= prevSignal && currMacd > currSignal,
        currMacd - currSignal,
        0,
      );
      const longSlopeUp = ctx.track(
        "L:ema_slope_positive",
        slopeVal > 0,
        slopeVal,
        0,
      );
      const longAboveEma = ctx.track(
        "L:price_above_ema",
        close > emaVal,
        close,
        emaVal,
      );

      if (longCross && longSlopeUp && longAboveEma) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "MACD bullish cross (EMA slope uptrend confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { positionDirection, positionEntryBarIndex, index } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB rule 6 — exempt from minHold)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Min hold period: trailing exit blocked for first MIN_HOLD_BARS bars (rule 9)
      // Hard SL handled by engine via computeLevels — exempt from minHold.
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // ── Chandelier trailing exit on 4H (long only) ──
      const ch = chandelierCache;
      if (!ch) return null;

      const chandelierLevel = ch.longExit[index];
      if (isNaN(chandelierLevel)) return null;

      ctx.indicator("chandelierLongExit", chandelierLevel);

      // Exit long when price drops below Chandelier Exit level
      if (positionDirection === "long" && ctx.currentCandle.c < chandelierLevel) {
        return { exit: true, comment: "Chandelier exit (long)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const ch = chandelierCache;
      if (!ch) return null;

      // Return Chandelier long exit level as trailing stop
      if (positionDirection === "long") {
        const level = ch.longExit[index];
        return isNaN(level) ? null : level;
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

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 0) return null;
      const atrVal = dAtr[dIdx];
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
