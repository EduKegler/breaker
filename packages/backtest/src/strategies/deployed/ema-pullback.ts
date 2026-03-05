import type { Candle } from "../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../types/strategy.js";
import { ema } from "../../indicators/ema.js";
import { rsi } from "../../indicators/rsi.js";
import { atr } from "../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface EmaPullbackParams {
  emaFast: StrategyParam;
  emaSlow: StrategyParam;
  rsiPeriod: StrategyParam;
  rsiOversold: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: EmaPullbackParams = {
  emaFast: { value: 9, min: 5, max: 15, step: 1, optimizable: true, description: "Fast EMA period for pullback detection" },
  emaSlow: { value: 21, min: 15, max: 30, step: 3, optimizable: true, description: "Slow EMA period for trend confirmation" },
  rsiPeriod: { value: 7, min: 5, max: 14, step: 1, optimizable: true, description: "RSI period for momentum filter" },
  rsiOversold: { value: 40, min: 30, max: 50, step: 5, optimizable: true, description: "RSI oversold threshold (overbought = 100 - this)" },
  atrStopMult: { value: 2.5, min: 2.5, max: 5.0, step: 0.5, optimizable: true, description: "ATR multiplier for safety stop (KB §1.6: min 2.5 for pullback)" },
  timeoutBars: { value: 30, min: 15, max: 50, step: 5, optimizable: true, description: "Bars before timeout exit" },
};

/**
 * BTC 15m Pullback — EMA Pullback strategy.
 *
 * Entry: Identify trend on 4H (EMA 21), wait for pullback on 15m (price crosses
 * below EMA fast), enter on resumption (price crosses back above EMA fast) with
 * RSI confirmation and close above EMA slow.
 * Exit: Trailing EMA fast + timeout.
 */
export function createEmaPullback(
  paramOverrides?: Partial<Record<keyof EmaPullbackParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof EmaPullbackParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Pre-computed indicator caches (populated by init())
  let emaFastCache: number[] | null = null;
  let emaSlowCache: number[] | null = null;
  let rsiCache: number[] | null = null;
  let htf4hEmaCache: number[] | null = null;
  let htfAtrCache: number[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htf1hCandles: Candle[] | null = null;

  return {
    name: "BTC 15m Pullback — EMA Pullback",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 22, "1h": 15, "4h": 22 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const closes = candles.map((c) => c.c);
      emaFastCache = ema(closes, params.emaFast.value);
      emaSlowCache = ema(closes, params.emaSlow.value);
      rsiCache = rsi(closes, params.rsiPeriod.value);

      htf4hCandles = higherTimeframes["4h"] ?? [];
      if (htf4hCandles.length > 0) {
        const htf4hCloses = htf4hCandles.map((c) => c.c);
        htf4hEmaCache = ema(htf4hCloses, 21);
      }

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache = atr(htf1hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;

      // Warmup: need at least emaSlow + 1 bars for previous-bar EMA access
      const warmup = Math.max(params.emaFast.value, params.emaSlow.value, params.rsiPeriod.value) + 1;
      if (index < warmup) return null;

      let emaFastArr = emaFastCache;
      let emaSlowArr = emaSlowCache;
      let rsiArr = rsiCache;
      if (!emaFastArr || !emaSlowArr || !rsiArr) {
        const closes = candles.map((c) => c.c);
        emaFastArr = emaFastArr ?? ema(closes, params.emaFast.value);
        emaSlowArr = emaSlowArr ?? ema(closes, params.emaSlow.value);
        rsiArr = rsiArr ?? rsi(closes, params.rsiPeriod.value);
      }

      const prevEmaFast = emaFastArr[index - 1];
      const currEmaFast = emaFastArr[index];
      const currEmaSlow = emaSlowArr[index];
      const currRsi = rsiArr[index];

      if (isNaN(prevEmaFast) || isNaN(currEmaFast) || isNaN(currEmaSlow) || isNaN(currRsi)) return null;

      const prevClose = candles[index - 1].c;
      const close = currentCandle.c;

      // 4H EMA 21 regime filter — only use COMPLETED 4H bars
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 22) return null;

      const htf4hEma = htf4hEmaCache ?? ema(htf4hRef.map((c) => c.c), 21);
      let ema21_4h = NaN;
      for (let j = htf4hRef.length - 1; j >= 0; j--) {
        if (htf4hRef[j].t + MS_4H <= currentCandle.t && !isNaN(htf4hEma[j])) {
          ema21_4h = htf4hEma[j];
          break;
        }
      }
      if (isNaN(ema21_4h)) return null;

      // 1H ATR for stop distance — only use COMPLETED 1H bars
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;

      const htfAtr = htfAtrCache ?? atr(htf1hRef, 14);
      let atr1h = NaN;
      for (let j = htf1hRef.length - 1; j >= 0; j--) {
        if (htf1hRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      const rsiOversold = params.rsiOversold.value;
      const rsiOverbought = 100 - rsiOversold;
      const stopDist = atr1h * params.atrStopMult.value;

      // Register indicator values for diagnostics
      ctx.indicator('emaFast', currEmaFast);
      ctx.indicator('emaSlow', currEmaSlow);
      ctx.indicator('rsi', currRsi);
      ctx.indicator('ema21_4h', ema21_4h);
      ctx.indicator('atr1h', atr1h);
      ctx.indicator('close', close);

      // LONG conditions
      const longRegime = ctx.track('L:regime_4h_bull', close > ema21_4h, close, ema21_4h);
      const longPullback = ctx.track('L:pullback', prevClose < prevEmaFast, prevClose, prevEmaFast);
      const longRecovery = ctx.track('L:recovery', close > currEmaFast, close, currEmaFast);
      const longTrend = ctx.track('L:above_emaSlow', close > currEmaSlow, close, currEmaSlow);
      const longMomentum = ctx.track('L:rsi_ok', currRsi > rsiOversold, currRsi, rsiOversold);

      if (longRegime && longPullback && longRecovery && longTrend && longMomentum) {
        // KB §5.1 rule 3: Structural confirmation — close above pullback high
        let pullbackHigh = -Infinity;
        for (let i = index - 1; i >= 0; i--) {
          if (isNaN(emaFastArr[i]) || candles[i].c >= emaFastArr[i]) break;
          pullbackHigh = Math.max(pullbackHigh, candles[i].h);
        }
        if (close <= pullbackHigh) return null;

        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "EMA pullback long",
        };
      }

      // SHORT conditions
      const shortRegime = ctx.track('S:regime_4h_bear', close < ema21_4h, close, ema21_4h);
      const shortPullback = ctx.track('S:pullback', prevClose > prevEmaFast, prevClose, prevEmaFast);
      const shortRecovery = ctx.track('S:recovery', close < currEmaFast, close, currEmaFast);
      const shortTrend = ctx.track('S:below_emaSlow', close < currEmaSlow, close, currEmaSlow);
      const shortMomentum = ctx.track('S:rsi_ok', currRsi < rsiOverbought, currRsi, rsiOverbought);

      if (shortRegime && shortPullback && shortRecovery && shortTrend && shortMomentum) {
        // KB §5.1 rule 3: Structural confirmation — close below pullback low
        let pullbackLow = Infinity;
        for (let i = index - 1; i >= 0; i--) {
          if (isNaN(emaFastArr[i]) || candles[i].c <= emaFastArr[i]) break;
          pullbackLow = Math.min(pullbackLow, candles[i].l);
        }
        if (close >= pullbackLow) return null;

        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "EMA pullback short",
        };
      }

      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htf1hRef, 14);
      let atr1h = NaN;
      for (let j = htf1hRef.length - 1; j >= 0; j--) {
        if (htf1hRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j]; break;
        }
      }
      if (isNaN(atr1h)) return null;

      const stopDist = atr1h * params.atrStopMult.value;
      const close = currentCandle.c;
      return {
        stopLoss: direction === "long" ? close - stopDist : close + stopDist,
        takeProfits: [], // Uses trailing exit
      };
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, positionDirection } = ctx;
      if (!positionDirection || index < params.emaFast.value + 1) return null;

      const emaFastArr = emaFastCache ?? ema(candles.map((c) => c.c), params.emaFast.value);
      const prevEmaFast = emaFastArr[index - 1];
      if (isNaN(prevEmaFast)) return null;

      return prevEmaFast;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, positionDirection, positionEntryBarIndex, positionEntryPrice } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout check
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      if (index < params.emaFast.value + 1) return null;

      const emaFastArr = emaFastCache ?? ema(candles.map((c) => c.c), params.emaFast.value);
      const prevEmaFast = emaFastArr[index - 1];
      if (isNaN(prevEmaFast)) return null;

      const currentCandle = candles[index];

      // Long exit: close below previous EMA fast — only at breakeven or better
      // (below breakeven the fixed SL on the exchange protects the position)
      if (positionDirection === "long" && currentCandle.c < prevEmaFast) {
        if (positionEntryPrice !== null && currentCandle.c < positionEntryPrice) return null;
        return { exit: true, comment: "EMA Trail" };
      }

      // Short exit: close above previous EMA fast — only at breakeven or better
      if (positionDirection === "short" && currentCandle.c > prevEmaFast) {
        if (positionEntryPrice !== null && currentCandle.c > positionEntryPrice) return null;
        return { exit: true, comment: "EMA Trail" };
      }

      return null;
    },
  };
}
