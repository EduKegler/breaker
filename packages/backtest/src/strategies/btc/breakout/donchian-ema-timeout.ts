import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import type { Candle } from "../../../types/candle.js";
import { donchian } from "../../../indicators/donchian.js";
import { ema } from "../../../indicators/ema.js";
import { atr } from "../../../indicators/atr.js";
import { sma } from "../../../indicators/sma.js";

const MS_1H = 3_600_000;

const DEFAULT_PARAMS: Record<string, StrategyParam> = {
  dcPeriod: { value: 20, min: 14, max: 30, step: 2, optimizable: true, description: "Donchian channel lookback period" },
  emaPeriod: { value: 50, min: 20, max: 100, step: 10, optimizable: true, description: "EMA period for trend filter" },
  atrStopMult: { value: 3.0, min: 3.0, max: 5.0, step: 0.5, optimizable: true, description: "ATR multiplier for stop loss (KB §1.6: min 3.0)" },
  tpRR: { value: 2.0, min: 1.5, max: 4.0, step: 0.5, optimizable: true, description: "Take-profit risk-reward ratio" },
  trailMult: { value: 3.0, min: 2.0, max: 5.0, step: 0.5, optimizable: true, description: "ATR multiplier for trailing stop" },
  volMult: { value: 2.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true, description: "Volume spike multiplier vs SMA(vol, 20)" },
  timeoutBars: { value: 48, min: 24, max: 96, step: 8, optimizable: true, description: "Bars before timeout exit (KB range: 24-96)" },
  cooldownBars: { value: 4, min: 2, max: 8, step: 1, optimizable: true, description: "Minimum bars between trades" },
};

/**
 * Build anti-repaint mapping from source candle indices to last completed HTF bar values.
 * For each source candle, finds the most recent HTF bar that has completed (bar.t + htfMs <= source.t)
 * and has a valid (non-NaN) indicator value.
 */
function mapHtfToSource(
  sourceCandles: Candle[],
  htfCandles: Candle[],
  htfValues: number[],
  htfMs: number,
): number[] {
  const result = new Array<number>(sourceCandles.length).fill(NaN);
  let lastValidIdx = -1;
  let j = 0;

  for (let i = 0; i < sourceCandles.length; i++) {
    const t = sourceCandles[i].t;
    while (j < htfCandles.length && htfCandles[j].t + htfMs <= t) {
      if (!isNaN(htfValues[j])) lastValidIdx = j;
      j++;
    }
    if (lastValidIdx >= 0) {
      result[i] = htfValues[lastValidIdx];
    }
  }

  return result;
}

/**
 * Donchian EMA Timeout — Donchian channel breakout with EMA trend filter and timeout exit.
 *
 * Entry: Price closes above/below Donchian channel in direction of EMA trend + volume spike.
 *        Long: close > DC upper (prev bar) AND close > EMA → bullish breakout in uptrend.
 *        Short: close < DC lower (prev bar) AND close < EMA → bearish breakout in downtrend.
 * Exit: Dual TP — TP1 at 1R (50%), TP2 at tpRR×R (50% remaining).
 *        ATR trailing stop tracks best price since entry.
 *        Timeout exit after timeoutBars.
 */
export function createDonchianEmaTimeout(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Pre-computed indicator arrays (populated in init())
  let _dcUpper: number[] = [];
  let _dcLower: number[] = [];
  let _ema: number[] = [];
  let _volSma20: number[] = [];
  let _atr1h: number[] = [];

  return {
    name: "BTC 15m Breakout — Donchian EMA Timeout",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 110, "1h": 15 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>) {
      const dcPeriod = params.dcPeriod.value;
      const emaPeriod = params.emaPeriod.value;
      const closes = candles.map((c: Candle) => c.c);

      // Donchian channel for breakout detection
      const dc = donchian(candles, dcPeriod);
      _dcUpper = dc.upper;
      _dcLower = dc.lower;

      // EMA trend filter on source timeframe
      _ema = ema(closes, emaPeriod);

      // Volume SMA for spike detection
      const volumes = candles.map((c: Candle) => c.v);
      _volSma20 = sma(volumes, 20);

      // 1H ATR mapped to source indices (anti-repaint)
      const htf1h = higherTimeframes["1h"];
      if (htf1h && htf1h.length >= 15) {
        const htfAtr = atr(htf1h, 14);
        _atr1h = mapHtfToSource(candles, htf1h, htfAtr, MS_1H);
      } else {
        _atr1h = new Array(candles.length).fill(NaN);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, barsSinceExit } = ctx;
      const dcPeriod = params.dcPeriod.value;
      const emaPeriod = params.emaPeriod.value;
      const warmup = Math.max(dcPeriod, emaPeriod) + 1;
      if (index < warmup) return null;

      // Cooldown between trades
      if (barsSinceExit < params.cooldownBars.value) return null;

      // --- Previous-bar indicator values (avoid look-ahead bias) ---
      const prevDcUpper = _dcUpper[index - 1];
      const prevDcLower = _dcLower[index - 1];
      if (isNaN(prevDcUpper) || isNaN(prevDcLower)) return null;
      ctx.indicator("dcUpper", prevDcUpper);
      ctx.indicator("dcLower", prevDcLower);

      const prevEma = _ema[index - 1];
      if (isNaN(prevEma)) return null;
      ctx.indicator("ema", prevEma);

      const currentVolSma = _volSma20[index];
      const currentVol = currentCandle.v;
      if (isNaN(currentVolSma)) return null;
      ctx.indicator("volume", currentVol);
      ctx.indicator("volSma20", currentVolSma);

      const atr1h = _atr1h[index];
      if (isNaN(atr1h)) return null;
      ctx.indicator("atr1h", atr1h);

      const stopDist = atr1h * params.atrStopMult.value;
      const volThreshold = params.volMult.value * currentVolSma;
      const tpRR = params.tpRR.value;

      // LONG: close breaks above DC upper + price above EMA (uptrend) + volume spike
      const longBreakout = currentCandle.c > prevDcUpper;
      const longTrend = currentCandle.c > prevEma;
      const longVol = currentVol > volThreshold;

      if (
        ctx.track("L:dcBreakout", longBreakout, currentCandle.c, prevDcUpper) &&
        ctx.track("L:emaTrend", longTrend, currentCandle.c, prevEma) &&
        ctx.track("L:volSpike", longVol, currentVol, volThreshold)
      ) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: currentCandle.c - stopDist,
          takeProfits: [
            { price: currentCandle.c + stopDist, pctOfPosition: 0.50 },
            { price: currentCandle.c + tpRR * stopDist, pctOfPosition: 0.50 },
          ],
          comment: "DC breakout long — EMA trend confirmed",
        };
      }

      // SHORT: close breaks below DC lower + price below EMA (downtrend) + volume spike
      const shortBreakout = currentCandle.c < prevDcLower;
      const shortTrend = currentCandle.c < prevEma;
      const shortVol = currentVol > volThreshold;

      if (
        ctx.track("S:dcBreakout", shortBreakout, currentCandle.c, prevDcLower) &&
        ctx.track("S:emaTrend", shortTrend, currentCandle.c, prevEma) &&
        ctx.track("S:volSpike", shortVol, currentVol, volThreshold)
      ) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: currentCandle.c + stopDist,
          takeProfits: [
            { price: currentCandle.c - stopDist, pctOfPosition: 0.50 },
            { price: currentCandle.c - tpRR * stopDist, pctOfPosition: 0.50 },
          ],
          comment: "DC breakout short — EMA trend confirmed",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout exit (MANDATORY first check)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "timeout" };
      }

      // ATR trailing stop — tracks best price since entry
      const atr1hVal = _atr1h[index];
      if (isNaN(atr1hVal)) return null;
      const trailDist = params.trailMult.value * atr1hVal;
      const currentCandle = ctx.candles[index];

      if (positionDirection === "long") {
        let highestHigh = -Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          highestHigh = Math.max(highestHigh, ctx.candles[k].h);
        }
        const trailStop = highestHigh - trailDist;
        if (currentCandle.c < trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      } else if (positionDirection === "short") {
        let lowestLow = Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          lowestLow = Math.min(lowestLow, ctx.candles[k].l);
        }
        const trailStop = lowestLow + trailDist;
        if (currentCandle.c > trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const atr1hVal = _atr1h[index];
      if (isNaN(atr1hVal)) return null;
      const trailDist = params.trailMult.value * atr1hVal;

      if (positionDirection === "long") {
        let highestHigh = -Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          highestHigh = Math.max(highestHigh, ctx.candles[k].h);
        }
        return highestHigh - trailDist;
      } else {
        let lowestLow = Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          lowestLow = Math.min(lowestLow, ctx.candles[k].l);
        }
        return lowestLow + trailDist;
      }
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;
      const atrStopMultVal = params.atrStopMult.value;
      const tpRR = params.tpRR.value;

      const htfCandles = higherTimeframes["1h"];
      if (!htfCandles || htfCandles.length < 15) return null;

      const htfAtr = atr(htfCandles, 14);
      let atr1h = NaN;
      for (let j = htfCandles.length - 1; j >= 0; j--) {
        if (htfCandles[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      const stopDist = atr1h * atrStopMultVal;

      if (direction === "long") {
        return {
          stopLoss: currentCandle.c - stopDist,
          takeProfits: [
            { price: currentCandle.c + stopDist, pctOfPosition: 0.50 },
            { price: currentCandle.c + tpRR * stopDist, pctOfPosition: 0.50 },
          ],
        };
      }

      return {
        stopLoss: currentCandle.c + stopDist,
        takeProfits: [
          { price: currentCandle.c - stopDist, pctOfPosition: 0.50 },
          { price: currentCandle.c - tpRR * stopDist, pctOfPosition: 0.50 },
        ],
      };
    },
  };
}
