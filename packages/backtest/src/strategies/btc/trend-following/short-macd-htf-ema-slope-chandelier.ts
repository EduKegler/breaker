import type { Candle } from "../../../types/candle.js";
import type {
  Strategy,
  StrategyContext,
  StrategyParam,
  Signal,
} from "../../../types/strategy.js";
import { macd } from "../../../indicators/macd.js";
import { ema } from "../../../indicators/ema.js";
import { slope } from "../../../indicators/slope.js";
import { atr } from "../../../indicators/atr.js";
import { chandelier } from "../../../indicators/chandelier.js";

const MS_1D = 86_400_000;

/** KB rule 9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** MACD signal EMA period (standard, fixed). */
const MACD_SIGNAL_PERIOD = 9;

/** Chandelier Exit ATR multiplier (fixed at standard default). */
const CHANDELIER_MULT = 3;

interface ShortMacdHtfEmaSlopeChandelierParams {
  macdFast: StrategyParam;
  macdSlow: StrategyParam;
  emaPeriod: StrategyParam;
  atrStopMult: StrategyParam;
  chandelierLen: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: ShortMacdHtfEmaSlopeChandelierParams = {
  macdFast: {
    value: 12,
    min: 8,
    max: 20,
    step: 2,
    optimizable: true,
    description: "MACD fast EMA period on 4H",
  },
  macdSlow: {
    value: 26,
    min: 20,
    max: 40,
    step: 2,
    optimizable: true,
    description: "MACD slow EMA period on 4H",
  },
  emaPeriod: {
    value: 20,
    min: 10,
    max: 50,
    step: 5,
    optimizable: true,
    description: "Daily EMA period for slope regime filter",
  },
  atrStopMult: {
    value: 4.5,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  chandelierLen: {
    value: 26,
    min: 10,
    max: 40,
    step: 4,
    optimizable: true,
    description: "Chandelier Exit lookback period on 4H (bars)",
  },
  timeoutBars: {
    value: 96,
    min: 60,
    max: 180,
    step: 6,
    optimizable: true,
    description: "Forced exit after N 4H bars (96 = 16 days)",
  },
};

export function createShortMacdHtfEmaSlopeChandelier(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let macdCache: { macd: number[]; signal: number[] } | null = null;
  let chandelierCache: { shortExit: number[] } | null = null;
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
    name: "BTC 4H Trend Following — Short MACD HTF EMA Slope Chandelier",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 100, "1d": 50 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes4h = candles.map((c) => c.c);

      // MACD on 4H candles (entry signal)
      macdCache = macd(
        closes4h,
        params.macdFast.value,
        params.macdSlow.value,
        MACD_SIGNAL_PERIOD,
      );

      // Chandelier Exit on 4H candles (trailing exit)
      const chanResult = chandelier(
        candles,
        params.chandelierLen.value,
        CHANDELIER_MULT,
      );
      chandelierCache = { shortExit: chanResult.shortExit };

      // Daily indicators (EMA slope regime + ATR for hard SL)
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyEmaCache = ema(dailyCloses, params.emaPeriod.value);
        dailyEmaSlopeCache = slope(dailyEmaCache, 1);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, higherTimeframes: htf } = ctx;

      if (index < 2) return null;

      // Only signal when flat — exits handled by shouldExit()
      if (ctx.positionDirection !== null) return null;

      // ── 4H MACD crossover (entry signal) ──
      if (!macdCache) return null;

      const currMacd = macdCache.macd[index];
      const prevMacd = macdCache.macd[index - 1];
      const currSignal = macdCache.signal[index];
      const prevSignal = macdCache.signal[index - 1];

      if (
        isNaN(currMacd) ||
        isNaN(prevMacd) ||
        isNaN(currSignal) ||
        isNaN(prevSignal)
      ) {
        return null;
      }

      // ── Daily candles — anti-lookahead ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 30) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 25) return null;

      // ── Daily EMA slope regime filter ──
      const dEma =
        dailyEmaCache ??
        ema(
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
      ctx.indicator("macd4h", currMacd);
      ctx.indicator("macdSignal4h", currSignal);
      ctx.indicator("macdHistogram4h", currMacd - currSignal);
      ctx.indicator("emaDaily", emaVal);
      ctx.indicator("emaSlopeDaily", slopeVal);
      ctx.indicator("atrDaily", atrVal);
      ctx.indicator("minHoldBars", MIN_HOLD_BARS);

      if (chandelierCache) {
        ctx.indicator("chandelierShortExit", chandelierCache.shortExit[index]);
      }

      // ── SHORT ONLY: MACD crosses below signal + Daily EMA slope falling + price below EMA ──
      const shortMacdCross = ctx.track(
        "S:macd_cross_bear",
        prevMacd >= prevSignal && currMacd < currSignal,
      );
      const shortSlopeDown = ctx.track(
        "S:ema_slope_negative",
        slopeVal < 0,
        slopeVal,
        0,
      );
      const shortBelowEma = ctx.track(
        "S:price_below_ema",
        close < emaVal,
        close,
        emaVal,
      );

      if (shortMacdCross && shortSlopeDown && shortBelowEma) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "MACD bearish cross (EMA slope downtrend confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB rule 6 — exempt from minHold)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Min hold period: trailing exit blocked for first MIN_HOLD_BARS bars (rule 9)
      // Hard SL handled by engine via computeLevels — exempt from minHold.
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // ── Chandelier Exit for short positions ──
      if (!chandelierCache) return null;

      const shortExitLevel = chandelierCache.shortExit[index];
      if (isNaN(shortExitLevel)) return null;

      ctx.indicator("chandelierShortExit", shortExitLevel);

      // Short exit: price high crosses above the chandelier short exit level
      if (ctx.currentCandle.h > shortExitLevel) {
        return { exit: true, comment: "Chandelier exit (short trail)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      if (!chandelierCache) return null;
      const val = chandelierCache.shortExit[ctx.index];
      return isNaN(val) ? null : val;
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
