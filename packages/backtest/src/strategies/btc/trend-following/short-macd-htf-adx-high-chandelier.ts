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
import {
  chandelier as chandelierIndicator,
  type ChandelierResult,
} from "../../../indicators/chandelier.js";

const MS_1D = 86_400_000;

/** KB §9: trailing exits blocked within first 3 bars (12h on 4H). Hard floor. */
const MIN_HOLD_BARS = 3;

/** Fixed MACD signal period (standard 9). Not optimizable to stay within 6-var cap. */
const MACD_SIGNAL_PERIOD = 9;

/** Fixed Chandelier lookback period (standard 22). Not optimizable to stay within 6-var cap. */
const CHANDELIER_PERIOD = 22;

interface ShortMacdHtfAdxHighChandelierParams {
  macdFast: StrategyParam;
  macdSlow: StrategyParam;
  adxThreshold: StrategyParam;
  atrStopMult: StrategyParam;
  chandelierMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: ShortMacdHtfAdxHighChandelierParams = {
  macdFast: {
    value: 12,
    min: 8,
    max: 16,
    step: 2,
    optimizable: true,
    description: "MACD fast EMA period on 4H",
  },
  macdSlow: {
    value: 34,
    min: 20,
    max: 34,
    step: 2,
    optimizable: true,
    description: "MACD slow EMA period on 4H",
  },
  adxThreshold: {
    value: 25,
    min: 25,
    max: 35,
    step: 1,
    optimizable: true,
    description:
      "ADX(14) Daily threshold — trend confirmed above this (KB floor: 25)",
  },
  atrStopMult: {
    value: 4,
    min: 3.0,
    max: 6.0,
    step: 0.5,
    optimizable: true,
    description: "Daily ATR(14) initial stop multiplier (KB floor: 3.0)",
  },
  chandelierMult: {
    value: 3,
    min: 2.0,
    max: 5.0,
    step: 0.5,
    optimizable: true,
    description: "Chandelier Exit ATR multiplier on 4H for trailing stop",
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

export function createShortMacdHtfAdxHighChandelier(
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
  let dailyAdxCache: AdxResult | null = null;
  let dailyAtrCache: number[] | null = null;
  let dailyCandlesRef: Candle[] | null = null;

  /** Find last completed Daily value (anti-lookahead: candle must be fully closed). */
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
    name: "BTC 4H Trend Following — Short MACD HTF ADX Chandelier",
    params,
    requiredTimeframes: ["1d"],
    requiredWarmup: { source: 100, "1d": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes = candles.map((c) => c.c);
      macdCache = macdIndicator(
        closes,
        params.macdFast.value,
        params.macdSlow.value,
        MACD_SIGNAL_PERIOD,
      );
      chandelierCache = chandelierIndicator(
        candles,
        CHANDELIER_PERIOD,
        params.chandelierMult.value,
      );
      dailyCandlesRef = higherTimeframes["1d"] ?? [];
      if (dailyCandlesRef.length > 0) {
        dailyAdxCache = adxIndicator(dailyCandlesRef, 14);
        dailyAtrCache = atr(dailyCandlesRef, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes: htf } = ctx;
      if (index < 2) return null;

      // ── MACD on source (4H) — accessed at index directly (no anti-lookahead for source TF) ──
      const closes = candles.slice(0, index + 1).map((c) => c.c);
      const m =
        macdCache ??
        macdIndicator(
          closes,
          params.macdFast.value,
          params.macdSlow.value,
          MACD_SIGNAL_PERIOD,
        );

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

      // ── Daily ADX (completed bar only — anti-lookahead) ──
      const dCandles = dailyCandlesRef ?? htf["1d"];
      if (!dCandles || dCandles.length < 28) return null;

      const dAdx = dailyAdxCache ?? adxIndicator(dCandles, 14);
      const adxVal = findDailyValue(currentCandle.t, dCandles, dAdx.adx);
      if (isNaN(adxVal)) return null;

      // ── Daily ATR for initial stop (completed bar only — anti-lookahead) ──
      const dAtr = dailyAtrCache ?? atr(dCandles, 14);
      const atrVal = findDailyValue(currentCandle.t, dCandles, dAtr);
      if (isNaN(atrVal)) return null;

      const adxThresh = params.adxThreshold.value;
      const close = currentCandle.c;
      const stopDist = atrVal * params.atrStopMult.value;

      // Diagnostics
      ctx.indicator("macdLine", currMacd);
      ctx.indicator("macdSignal", currSignal);
      ctx.indicator("macdHist", currMacd - currSignal);
      ctx.indicator("adxDaily", adxVal);
      ctx.indicator("atrDaily", atrVal);

      // ── SHORT ONLY: MACD line crosses below signal line + ADX confirms trend ──
      const shortCross = ctx.track(
        "S:macd_cross_bear",
        prevMacd >= prevSignal && currMacd < currSignal,
      );
      const shortAdx = ctx.track(
        "S:adx_trend",
        adxVal >= adxThresh,
        adxVal,
        adxThresh,
      );

      if (shortCross && shortAdx) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "MACD cross bearish (ADX trend confirmed)",
        };
      }

      return null;
    },

    shouldExit(
      ctx: StrategyContext,
    ): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryBarIndex } =
        ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;

      // Timeout fires regardless of hold period (KB §6)
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Trailing exit blocked during minimum hold (KB §9)
      if (barsInTrade < MIN_HOLD_BARS) return null;

      // Chandelier Exit: short position exits when price rises above shortExit level
      const chand =
        chandelierCache ??
        chandelierIndicator(
          candles.slice(0, index + 1),
          CHANDELIER_PERIOD,
          params.chandelierMult.value,
        );
      const exitLevel = chand.shortExit[index];
      if (isNaN(exitLevel)) return null;

      if (positionDirection === "short" && currentCandle.c > exitLevel) {
        return { exit: true, comment: "Chandelier exit (short)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // No trailing level during min hold period
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade < MIN_HOLD_BARS) return null;

      const chand =
        chandelierCache ??
        chandelierIndicator(
          candles.slice(0, index + 1),
          CHANDELIER_PERIOD,
          params.chandelierMult.value,
        );
      const exitLevel = chand.shortExit[index];
      if (isNaN(exitLevel)) return null;

      return exitLevel;
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
