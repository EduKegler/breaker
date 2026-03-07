import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../../types/strategy.js";
import type { Candle } from "../../../../types/candle.js";
import { bollingerBands } from "../../../../indicators/bollinger-bands.js";
import { keltner } from "../../../../indicators/keltner.js";
import { detectSqueeze } from "../../../../indicators/detect-squeeze.js";
import { donchian } from "../../../../indicators/donchian.js";
import { ema } from "../../../../indicators/ema.js";
import { atr } from "../../../../indicators/atr.js";
import { sma } from "../../../../indicators/sma.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

const DAILY_EMA_PERIOD = 200; // fixed — institutional trend filter (0 vars)
const SQUEEZE_LOOKBACK = 3;   // bars to look back for recent squeeze

export interface DonchianAdxParams {
  bbKcPeriod: StrategyParam;
  kcMult: StrategyParam;
  bbStdDev: StrategyParam;
  atrStopMult: StrategyParam;
  volMult: StrategyParam;
  tpRR: StrategyParam;
  trailMult: StrategyParam;
  timeoutBars: StrategyParam;
  maxTradesDay: StrategyParam;
}

const DEFAULT_PARAMS: DonchianAdxParams = {
  bbKcPeriod: { value: 20, min: 14, max: 30, step: 2, optimizable: true, description: "Shared period for BB and KC (squeeze detection)" },
  kcMult: { value: 1.5, min: 1, max: 2.5, step: 0.25, optimizable: true, description: "Keltner Channel ATR multiplier" },
  bbStdDev: { value: 2, min: 1.5, max: 2.5, step: 0.25, optimizable: true, description: "Bollinger Bands standard deviation multiplier" },
  atrStopMult: { value: 3, min: 3, max: 5, step: 0.5, optimizable: true, description: "ATR multiplier for safety stop (KB §1.6: min 3.0 for breakout)" },
  volMult: { value: 2, min: 1, max: 3, step: 0.5, optimizable: true, description: "Volume spike multiplier vs SMA(vol, 20) — KB §3.1 rule 3" },
  tpRR: { value: 1.5, min: 1.5, max: 3, step: 0.5, optimizable: true, description: "TP risk-reward ratio" },
  trailMult: { value: 3, min: 2, max: 5, step: 0.5, optimizable: true, description: "ATR multiplier for trailing stop (tracks best price since entry)" },
  timeoutBars: { value: 48, min: 24, max: 96, step: 8, optimizable: true, description: "Bars before timeout exit (KB range: 24–96)" },
  maxTradesDay: { value: 3, min: 2, max: 5, step: 1, optimizable: false, description: "Max trades per day" },
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
 * BB Squeeze Release Breakout (short-only) — Daily EMA 200 regime + volume + dual TP.
 *
 * Entry: BB/KC squeeze detected → squeeze release → price closes below DC lower AND BB lower
 *        (momentum confirmation) + Daily EMA 200 regime (below) + volume spike.
 *        Long entries disabled (structural: Long PF=0).
 * Exit: Dual TP — TP1 at 1R (40%), TP2 at tpRR×R (50% of remaining), ATR trail for remainder.
 *
 * TP1 at stopDist (1R) dramatically increases TP hit rate vs prior single TP at 2R.
 * ATR trail tracks lowest low since entry + trailMult × ATR(1H) for remaining 30%.
 */
export function createDonchianAdx(
  paramOverrides?: Partial<Record<keyof DonchianAdxParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof DonchianAdxParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Pre-computed indicator arrays (populated in init())
  let _squeezeOn: boolean[] = [];
  let _dcUpper: number[] = [];
  let _dcLower: number[] = [];
  let _bbUpper: number[] = [];
  let _bbLower: number[] = [];
  let _volSma20: number[] = [];
  let _atr1h: number[] = [];
  let _emaDaily: number[] = [];

  return {
    name: "BTC 15m Breakout — BB Squeeze Short + Dual TP",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 40, "1h": 15, "1d": 210 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>) {
      const period = params.bbKcPeriod.value;
      const closes = candles.map((c: Candle) => c.c);

      // Bollinger Bands on 15m closes
      const bb = bollingerBands(closes, period, params.bbStdDev.value);
      _bbUpper = bb.upper;
      _bbLower = bb.lower;

      // Keltner Channel on 15m candles
      const kc = keltner(candles, period, period, params.kcMult.value);

      // Squeeze detection (BB inside KC)
      const squeeze = detectSqueeze(bb, kc, 1); // minBars=1, any single squeeze bar counts
      _squeezeOn = squeeze.squeezeOn;

      // Donchian channel for breakout detection (entry only)
      const dc = donchian(candles, period);
      _dcUpper = dc.upper;
      _dcLower = dc.lower;

      // Volume SMA
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

      // Daily EMA 200 mapped to source indices (anti-repaint)
      const d1 = higherTimeframes["1d"];
      if (d1 && d1.length >= DAILY_EMA_PERIOD + 1) {
        const d1Closes = d1.map((c: Candle) => c.c);
        const ema200 = ema(d1Closes, DAILY_EMA_PERIOD);
        _emaDaily = mapHtfToSource(candles, d1, ema200, MS_1D);
      } else {
        _emaDaily = new Array(candles.length).fill(NaN);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle } = ctx;
      const period = params.bbKcPeriod.value;
      if (index < period + 1) return null;

      // --- Indicators ---
      const prevDcUpper = _dcUpper[index - 1];
      const prevDcLower = _dcLower[index - 1];
      if (isNaN(prevDcUpper) || isNaN(prevDcLower)) return null;
      ctx.indicator("dcUpper", prevDcUpper);
      ctx.indicator("dcLower", prevDcLower);

      ctx.indicator("bbUpper", _bbUpper[index]);
      ctx.indicator("bbLower", _bbLower[index]);

      const currentVolSma = _volSma20[index];
      const currentVol = currentCandle.v;
      if (isNaN(currentVolSma)) return null;
      ctx.indicator("volume", currentVol);
      ctx.indicator("volSma20", currentVolSma);

      const atr1h = _atr1h[index];
      if (isNaN(atr1h)) return null;
      ctx.indicator("atr1h", atr1h);

      const htfEma = _emaDaily[index];
      if (isNaN(htfEma)) return null;
      ctx.indicator("emaDaily200", htfEma);

      // --- Squeeze release detection ---
      let hadSqueeze = false;
      for (let k = 1; k <= SQUEEZE_LOOKBACK && index - k >= 0; k++) {
        if (_squeezeOn[index - k]) { hadSqueeze = true; break; }
      }
      const released = !_squeezeOn[index]; // BB now outside KC
      const squeezeRelease = hadSqueeze && released;
      ctx.indicator("squeezeOn", _squeezeOn[index] ? 1 : 0);
      ctx.indicator("squeezeRelease", squeezeRelease ? 1 : 0);

      const stopDist = atr1h * params.atrStopMult.value;
      const volThreshold = params.volMult.value * currentVolSma;
      const tpRR = params.tpRR.value;

      // LONG signal — disabled (structural: Long PF=0, WR=0%)
      // Track calls preserved for diagnostics
      const longBreakout = currentCandle.c > prevDcUpper;
      const longRegime = currentCandle.c > htfEma;
      const longVol = currentVol > volThreshold;

      if (
        ctx.track("L:squeezeRelease", squeezeRelease, squeezeRelease ? 1 : 0, 1) &&
        ctx.track("L:dcBreakout", longBreakout, currentCandle.c, prevDcUpper) &&
        ctx.track("L:regime", longRegime, currentCandle.c, htfEma) &&
        ctx.track("L:volSpike", longVol, currentVol, volThreshold)
      ) {
        // Long entries disabled — structural diagnostic: Long PF=0, WR=0%
      }

      // SHORT signal: squeeze release + DC breakout + BB momentum + Daily EMA regime + volume
      const shortBreakout = currentCandle.c < prevDcLower;
      const shortBbBreak = currentCandle.c < _bbLower[index];
      const shortRegime = currentCandle.c < htfEma;
      const shortVol = currentVol > volThreshold;

      if (
        ctx.track("S:squeezeRelease", squeezeRelease, squeezeRelease ? 1 : 0, 1) &&
        ctx.track("S:dcBreakout", shortBreakout, currentCandle.c, prevDcLower) &&
        ctx.track("S:bbBreak", shortBbBreak, currentCandle.c, _bbLower[index]) &&
        ctx.track("S:regime", shortRegime, currentCandle.c, htfEma) &&
        ctx.track("S:volSpike", shortVol, currentVol, volThreshold)
      ) {
        // Dual TP: TP1 at 1R (40%) locks profit early; TP2 at tpRR×R (50% of remaining = 30%);
        // trailing stop handles final 30% for outsized moves.
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: currentCandle.c + stopDist,
          takeProfits: [
            { price: currentCandle.c - stopDist, pctOfPosition: 0.40 },
            { price: currentCandle.c - tpRR * stopDist, pctOfPosition: 0.50 },
          ],
          comment: "Squeeze release short — dual TP",
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

      if (positionDirection === "short") {
        let lowestLow = Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          lowestLow = Math.min(lowestLow, ctx.candles[k].l);
        }
        const trailStop = lowestLow + trailDist;
        if (currentCandle.c > trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      } else if (positionDirection === "long") {
        let highestHigh = -Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          highestHigh = Math.max(highestHigh, ctx.candles[k].h);
        }
        const trailStop = highestHigh - trailDist;
        if (currentCandle.c < trailStop) {
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

      if (positionDirection === "short") {
        let lowestLow = Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          lowestLow = Math.min(lowestLow, ctx.candles[k].l);
        }
        return lowestLow + trailDist;
      } else {
        let highestHigh = -Infinity;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          highestHigh = Math.max(highestHigh, ctx.candles[k].h);
        }
        return highestHigh - trailDist;
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
            { price: currentCandle.c + stopDist, pctOfPosition: 0.40 },
            { price: currentCandle.c + tpRR * stopDist, pctOfPosition: 0.50 },
          ],
        };
      }

      return {
        stopLoss: currentCandle.c + stopDist,
        takeProfits: [
          { price: currentCandle.c - stopDist, pctOfPosition: 0.40 },
          { price: currentCandle.c - tpRR * stopDist, pctOfPosition: 0.50 },
        ],
      };
    },
  };
}
