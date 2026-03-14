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
  adx as adxIndicator,
  type AdxResult,
} from "../../../indicators/adx.js";
import { atr } from "../../../indicators/atr.js";
import { ema } from "../../../indicators/ema.js";

const MS_1D = 86_400_000;

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed MACD slow / signal periods (standard 26/9). Only fast is tunable. */
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

interface MacdHtfAdxHighMaExitParams {
  macdFast: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: MacdHtfAdxHighMaExitParams = {
  macdFast: {
    value: 16,
    min: 8,
    max: 20,
    step: 2,
    optimizable: true,
    description:
      "MACD fast EMA period on 4H (slow=26, signal=9 fixed). MA exit reuses this EMA vs 26-period slow EMA.",
  },
  adxThreshold: {
    value: 28,
    min: 25,
    max: 35,
    step: 1,
    optimizable: true,
    description:
      "ADX(14) Daily threshold — trend confirmed above this (KB floor: 25)",
  },
  atrStopMult: {
    value: 4.5,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
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

export function createMacdHtfAdxHighMaExit(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let macd4hCache: MacdResult | null = null;
  let slowEmaCache: number[] | null = null;
  let dailyMacdCache: MacdResult | null = null;
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

  return {
    name: "BTC 4H Trend Following — MACD HTF ADX High MA Exit",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 50, "1d": 50 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes4h = candles.map((c) => c.c);

      // 4H MACD for entry signal + exit zero-line cross
      macd4hCache = macdIndicator(
        closes4h,
        params.macdFast.value,
        MACD_SLOW,
        MACD_SIGNAL,
      );

      // 4H slow EMA cache for getExitLevel approximation
      slowEmaCache = ema(closes4h, MACD_SLOW);

      // Daily indicators
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        const dailyCloses = dailyCandlesRef.map((c) => c.c);
        dailyMacdCache = macdIndicator(
          dailyCloses,
          params.macdFast.value,
          MACD_SLOW,
          MACD_SIGNAL,
        );
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { currentCandle, index, higherTimeframes: htf } = ctx;

      // MACD warmup: slow + signal - 2 = 33, add buffer
      if (index < 35) return null;

      // ── 4H MACD (source timeframe) ──
      const macd4h = macd4hCache;
      if (!macd4h) return null;

      const macdLine = macd4h.macd[index];
      const signalLine = macd4h.signal[index];
      const prevMacdLine = macd4h.macd[index - 1];
      const prevSignalLine = macd4h.signal[index - 1];

      if (
        isNaN(macdLine) ||
        isNaN(signalLine) ||
        isNaN(prevMacdLine) ||
        isNaN(prevSignalLine)
      ) {
        return null;
      }

      // ── Daily data (anti-lookahead: last fully-closed bar) ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 35) return null;

      const dIdx = findLastDailyIdx(currentCandle.t, dCandles);
      if (dIdx < 34) return null;

      // ── Daily MACD alignment ──
      const dMacd =
        dailyMacdCache ??
        macdIndicator(
          dCandles.map((c) => c.c),
          params.macdFast.value,
          MACD_SLOW,
          MACD_SIGNAL,
        );
      const dailyMacdVal = dMacd.macd[dIdx];
      const dailySignalVal = dMacd.signal[dIdx];
      if (isNaN(dailyMacdVal) || isNaN(dailySignalVal)) return null;

      // ── Daily ADX (strength gate only — no DI) ──
      const dAdx = dailyAdxCache ?? adxIndicator(dCandles, 14);
      const adxVal = dAdx.adx[dIdx];
      if (isNaN(adxVal)) return null;

      // ── Daily ATR for initial stop ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = dAtr[dIdx];
      if (isNaN(atrVal)) return null;

      const adxThresh = params.adxThreshold.value;
      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("macd4h", macdLine);
      ctx.indicator("signal4h", signalLine);
      ctx.indicator("dailyMacd", dailyMacdVal);
      ctx.indicator("dailySignal", dailySignalVal);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);

      // ── LONG: 4H MACD cross above signal + Daily MACD above signal + ADX ──
      const longCross = ctx.track(
        "L:macd_cross",
        macdLine > signalLine && prevMacdLine <= prevSignalLine,
        macdLine,
        signalLine,
      );
      const longAlign = ctx.track(
        "L:daily_macd_align",
        dailyMacdVal > dailySignalVal,
        dailyMacdVal,
        dailySignalVal,
      );
      const longAdx = ctx.track(
        "L:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (longCross && longAlign && longAdx) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "MACD HTF cross long (Daily aligned + ADX confirmed)",
        };
      }

      // ── SHORT: 4H MACD cross below signal + Daily MACD below signal + ADX ──
      const shortCross = ctx.track(
        "S:macd_cross",
        macdLine < signalLine && prevMacdLine >= prevSignalLine,
        macdLine,
        signalLine,
      );
      const shortAlign = ctx.track(
        "S:daily_macd_align",
        dailyMacdVal < dailySignalVal,
        dailyMacdVal,
        dailySignalVal,
      );
      const shortAdx = ctx.track(
        "S:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (shortCross && shortAlign && shortAdx) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "MACD HTF cross short (Daily aligned + ADX confirmed)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) {
        return null;
      }

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB §6)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // MA exit blocked during minimum hold (KB §9)
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // ── MA Exit: MACD zero-line cross = fast EMA crosses slow EMA ──
      const macd4h = macd4hCache;
      if (!macd4h) return null;

      const macdNow = macd4h.macd[index];
      const macdPrev = macd4h.macd[index - 1];
      if (isNaN(macdNow) || isNaN(macdPrev)) return null;

      if (positionDirection === "long") {
        // Death cross: fast EMA crosses below slow EMA (MACD crosses zero downward)
        if (macdNow < 0 && macdPrev >= 0) {
          return { exit: true, comment: "MA exit — death cross (long)" };
        }
      }

      if (positionDirection === "short") {
        // Golden cross: fast EMA crosses above slow EMA (MACD crosses zero upward)
        if (macdNow > 0 && macdPrev <= 0) {
          return { exit: true, comment: "MA exit — golden cross (short)" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) {
        return null;
      }

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // Approximate exit level: slow EMA(26) value on 4H.
      // When price approaches the slow EMA, the fast EMA converges and
      // the MACD zero-line cross (MA exit) becomes imminent.
      const slowVal = slowEmaCache?.[index];
      if (slowVal === undefined || isNaN(slowVal)) return null;

      return slowVal;
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
