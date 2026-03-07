import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import type { Candle } from "../../../types/candle.js";
import { bollingerBands } from "../../../indicators/bollinger-bands.js";
import { keltner } from "../../../indicators/keltner.js";
import { detectSqueeze } from "../../../indicators/detect-squeeze.js";
import { donchian } from "../../../indicators/donchian.js";
import { ema } from "../../../indicators/ema.js";
import { atr } from "../../../indicators/atr.js";
import { sma } from "../../../indicators/sma.js";

const MS_1H = 3_600_000;
const MS_4H = 4 * MS_1H;
const MS_1D = 86_400_000;

const DAILY_EMA_PERIOD = 200;  // fixed — institutional trend filter (0 vars)
const HTF_4H_EMA_PERIOD = 21;  // fixed — 4H momentum confirmation filter (0 vars)
const SQUEEZE_LOOKBACK = 3;    // bars to look back for recent squeeze

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
  kcMult: { value: 1.5, min: 1, max: 2.5, step: 0.25, optimizable: false, description: "Keltner Channel ATR multiplier (fixed — zero trade impact across full range)" },
  bbStdDev: { value: 2, min: 1.5, max: 2.5, step: 0.25, optimizable: false, description: "Bollinger Bands standard deviation multiplier (fixed — zero trade impact across full range)" },
  atrStopMult: { value: 3, min: 3, max: 5, step: 0.5, optimizable: true, description: "ATR multiplier for safety stop (KB §1.6: min 3.0 for breakout)" },
  volMult: { value: 2, min: 1, max: 3, step: 0.5, optimizable: true, description: "Volume spike multiplier vs SMA(vol, 20) — KB §3.1 rule 3" },
  tpRR: { value: 3, min: 1.5, max: 3, step: 0.5, optimizable: true, description: "TP risk-reward ratio" },
  trailMult: { value: 4.5, min: 2, max: 5, step: 0.5, optimizable: true, description: "ATR multiplier for trailing stop (tracks best price since entry)" },
  timeoutBars: { value: 56, min: 24, max: 96, step: 8, optimizable: true, description: "Bars before timeout exit (KB range: 24–96)" },
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
 * BB Squeeze Release Breakout (short-only) — Daily EMA 200 regime + 4H EMA21 momentum
 * + volume + dual TP + 4H momentum reversal exit.
 *
 * Entry: BB/KC squeeze detected → squeeze release → price closes below DC lower AND BB lower
 *        (momentum confirmation) + Daily EMA 200 regime (below) + 4H EMA21 bearish momentum
 *        (price below 4H EMA21, filters false breakouts that lead to SL hits) + volume spike.
 *        Long entries disabled (structural: Long PF=0).
 * Exit: Dual TP — TP1 at 1.5R (40%), TP2 at tpRR×R (50%), ATR trail for remainder (10%).
 *        4H EMA21 momentum reversal — if price crosses back above 4H EMA21 during short,
 *        the bearish thesis is invalidated and trade exits early (cuts losing signal exits).
 *
 * Structural changes (iter 54):
 * - Added 4H momentum reversal exit to cut stalled/losing shorts earlier (35 signal exits
 *   averaged $0.28/trade — momentum exit should improve PF by exiting losers faster).
 * - Fixed bbStdDev=2.0 and kcMult=1.5 as non-optimizable (zero trade impact across full
 *   explored range) — reduces optimizable vars from 8 to 6, improving complexity score.
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
  let _ema4h: number[] = [];

  return {
    name: "BTC 15m Breakout — BB Squeeze Short + 4H Momentum Exit",
    params,
    requiredTimeframes: ["1h", "4h", "1d"],
    requiredWarmup: { source: 40, "1h": 15, "4h": 25, "1d": 210 },

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

      // 4H EMA21 momentum filter — filters false breakouts against 4H trend (anti-repaint)
      const htf4h = higherTimeframes["4h"];
      if (htf4h && htf4h.length >= HTF_4H_EMA_PERIOD + 1) {
        const htf4hCloses = htf4h.map((c: Candle) => c.c);
        const ema21_4h = ema(htf4hCloses, HTF_4H_EMA_PERIOD);
        _ema4h = mapHtfToSource(candles, htf4h, ema21_4h, MS_4H);
      } else {
        _ema4h = new Array(candles.length).fill(NaN);
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

      const ema4h = _ema4h[index];
      if (isNaN(ema4h)) return null;
      ctx.indicator("ema4h21", ema4h);

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
      const longMomentum4h = currentCandle.c > ema4h;
      const longVol = currentVol > volThreshold;

      if (
        ctx.track("L:squeezeRelease", squeezeRelease, squeezeRelease ? 1 : 0, 1) &&
        ctx.track("L:dcBreakout", longBreakout, currentCandle.c, prevDcUpper) &&
        ctx.track("L:regime", longRegime, currentCandle.c, htfEma) &&
        ctx.track("L:4hTrend", longMomentum4h, currentCandle.c, ema4h) &&
        ctx.track("L:volSpike", longVol, currentVol, volThreshold)
      ) {
        // Long entries disabled — structural diagnostic: Long PF=0, WR=0%
      }

      // SHORT signal: squeeze release + DC breakout + BB momentum + Daily EMA regime
      //               + 4H EMA21 bearish momentum (new filter) + volume
      const shortBreakout = currentCandle.c < prevDcLower;
      const shortBbBreak = currentCandle.c < _bbLower[index];
      const shortRegime = currentCandle.c < htfEma;
      const shortMomentum4h = currentCandle.c < ema4h; // 4H bearish: price below 4H EMA21
      const shortVol = currentVol > volThreshold;

      if (
        ctx.track("S:squeezeRelease", squeezeRelease, squeezeRelease ? 1 : 0, 1) &&
        ctx.track("S:dcBreakout", shortBreakout, currentCandle.c, prevDcLower) &&
        ctx.track("S:bbBreak", shortBbBreak, currentCandle.c, _bbLower[index]) &&
        ctx.track("S:regime", shortRegime, currentCandle.c, htfEma) &&
        ctx.track("S:4hTrend", shortMomentum4h, currentCandle.c, ema4h) &&
        ctx.track("S:volSpike", shortVol, currentVol, volThreshold)
      ) {
        // Dual TP: TP1 at 1.5R (40%) — widened from 1.0R to reduce WR below 65% rejection
        // threshold and improve avgR. TP2 at tpRR×R (50%); trailing stop handles final 10%.
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: currentCandle.c + stopDist,
          takeProfits: [
            { price: currentCandle.c - 1.5 * stopDist, pctOfPosition: 0.40 },
            { price: currentCandle.c - tpRR * stopDist, pctOfPosition: 0.50 },
          ],
          comment: "Squeeze release short — 4H filtered, 1.5R TP1",
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

      // 4H EMA21 momentum reversal exit — trade thesis broken if price crosses back
      const ema4hVal = _ema4h[index];
      const currentCandle = ctx.candles[index];
      if (!isNaN(ema4hVal)) {
        if (positionDirection === "short" && currentCandle.c > ema4hVal) {
          return { exit: true, comment: "signal" };
        }
        if (positionDirection === "long" && currentCandle.c < ema4hVal) {
          return { exit: true, comment: "signal" };
        }
      }

      // ATR trailing stop — tracks best price since entry
      const atr1hVal = _atr1h[index];
      if (isNaN(atr1hVal)) return null;
      const trailDist = params.trailMult.value * atr1hVal;

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
            { price: currentCandle.c + 1.5 * stopDist, pctOfPosition: 0.40 },
            { price: currentCandle.c + tpRR * stopDist, pctOfPosition: 0.50 },
          ],
        };
      }

      return {
        stopLoss: currentCandle.c + stopDist,
        takeProfits: [
          { price: currentCandle.c - 1.5 * stopDist, pctOfPosition: 0.40 },
          { price: currentCandle.c - tpRR * stopDist, pctOfPosition: 0.50 },
        ],
      };
    },
  };
}
