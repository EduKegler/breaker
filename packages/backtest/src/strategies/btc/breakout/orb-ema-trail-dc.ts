import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { donchian } from "../../../indicators/donchian.js";
import { ema as emaIndicator } from "../../../indicators/ema.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_1D = 86_400_000;

interface OrbEmaTrailDcParams {
  orbMinutes: StrategyParam;
  emaPeriod: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  trailDcPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: OrbEmaTrailDcParams = {
  orbMinutes: {
    value: 30, min: 15, max: 60, step: 15, optimizable: true,
    description: "ORB formation period in minutes (multiples of 15)",
  },
  emaPeriod: {
    value: 50, min: 20, max: 100, step: 10, optimizable: true,
    description: "Daily EMA period for regime filter",
  },
  volMultiplier: {
    value: 2.0, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  trailDcPeriod: {
    value: 10, min: 5, max: 20, step: 1, optimizable: true,
    description: "Fast Donchian period for trailing channel exit (opposite band)",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

function getSessionOpen(t: number): "london" | "ny" | null {
  const d = new Date(t);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  if (h === 8 && m === 0) return "london";
  if (h === 13 && m === 30) return "ny";
  return null;
}

export function createOrbEmaTrailDc(
  paramOverrides?: Partial<Record<keyof OrbEmaTrailDcParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof OrbEmaTrailDcParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let exitDcCache: { upper: number[]; lower: number[]; mid: number[] } | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf1dCandles: Candle[] | null = null;
  let htf1dEmaCache: number[] | null = null;

  // ORB bar-by-bar state
  let orbHigh = NaN;
  let orbLow = NaN;
  let orbBarsLeft = 0;
  let orbArmed = false;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — ORB EMA Trail-DC",
    params,
    requiredTimeframes: ["1h", "1d"],
    requiredWarmup: { source: 50, "1h": 15, "1d": 120 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      exitDcCache = donchian(candles, params.trailDcPeriod.value);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf1dCandles = higherTimeframes["1d"] ?? [];
      if (htf1dCandles.length > 0) {
        htf1dEmaCache = emaIndicator(htf1dCandles.map(c => c.c), params.emaPeriod.value);
      }
      orbHigh = NaN;
      orbLow = NaN;
      orbBarsLeft = 0;
      orbArmed = false;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 20) return null;

      const orbBarsCount = Math.max(1, Math.round(params.orbMinutes.value / 15));

      // --- ORB state update ---
      const session = getSessionOpen(currentCandle.t);
      if (session) {
        orbHigh = currentCandle.h;
        orbLow = currentCandle.l;
        orbBarsLeft = orbBarsCount - 1;
        orbArmed = orbBarsLeft === 0;
        return null; // never enter on session-open bar
      }

      if (orbBarsLeft > 0) {
        orbHigh = Math.max(orbHigh, currentCandle.h);
        orbLow = Math.min(orbLow, currentCandle.l);
        orbBarsLeft--;
        if (orbBarsLeft === 0) orbArmed = true;
        return null; // still forming
      }

      if (!orbArmed || isNaN(orbHigh) || isNaN(orbLow)) return null;

      // --- HTF: 1H ATR (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- Daily EMA regime filter (anti-repaint) ---
      const htf1dRef = htf1dCandles ?? higherTimeframes["1d"];
      if (!htf1dRef || htf1dRef.length < params.emaPeriod.value) return null;
      const dailyEma = htf1dEmaCache ?? emaIndicator(htf1dRef.map(c => c.c), params.emaPeriod.value);
      let emaValue = NaN;
      let dailyClose = NaN;
      for (let j = htf1dRef.length - 1; j >= 0; j--) {
        if (htf1dRef[j].t + MS_1D <= currentCandle.t && !isNaN(dailyEma[j])) {
          emaValue = dailyEma[j];
          dailyClose = htf1dRef[j].c;
          break;
        }
      }
      if (isNaN(emaValue)) return null;

      // --- Volume SMA(20) ---
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;

      // --- Diagnostics ---
      ctx.indicator("orbHigh", orbHigh);
      ctx.indicator("orbLow", orbLow);
      ctx.indicator("close", close);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("dailyEma", emaValue);
      ctx.indicator("dailyClose", dailyClose);
      ctx.indicator("volAvg20", volAvg20);

      // --- LONG: close above orbHigh + daily close > EMA (bullish regime) + volume spike ---
      const longBreakout = ctx.track("L:close_above_orb", close > orbHigh, close, orbHigh);
      const longRegime = ctx.track("L:above_daily_ema", dailyClose > emaValue, dailyClose, emaValue);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreakout && longRegime && longVol) {
        const sl = close - stopDist;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "ORB breakout long (EMA regime)",
        };
      }

      // --- SHORT: close below orbLow + daily close < EMA (bearish regime) + volume spike ---
      const shortBreakout = ctx.track("S:close_below_orb", close < orbLow, close, orbLow);
      const shortRegime = ctx.track("S:below_daily_ema", dailyClose < emaValue, dailyClose, emaValue);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreakout && shortRegime && shortVol) {
        const sl = close + stopDist;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "ORB breakout short (EMA regime)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, candles, currentCandle, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Session change exit — ORB trades should resolve within session
      if (getSessionOpen(currentCandle.t)) {
        return { exit: true, comment: "Session change" };
      }

      // Trailing Donchian channel exit (opposite band)
      const trailPeriod = params.trailDcPeriod.value;
      if (barsInTrade < trailPeriod) return null; // need enough bars for channel

      const exitDc = exitDcCache ?? donchian(candles.slice(0, index + 1), trailPeriod);
      const close = currentCandle.c;

      if (positionDirection === "long") {
        const exitLevel = exitDc.lower[index - 1]; // previous bar's lower channel
        if (!isNaN(exitLevel) && close < exitLevel) {
          return { exit: true, comment: "Trail DC" };
        }
      } else {
        const exitLevel = exitDc.upper[index - 1]; // previous bar's upper channel
        if (!isNaN(exitLevel) && close > exitLevel) {
          return { exit: true, comment: "Trail DC" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { index, candles, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      const trailPeriod = params.trailDcPeriod.value;
      if (barsInTrade < trailPeriod) return null;

      const exitDc = exitDcCache ?? donchian(candles.slice(0, index + 1), trailPeriod);

      if (positionDirection === "long") {
        return exitDc.lower[index - 1] ?? null;
      } else {
        return exitDc.upper[index - 1] ?? null;
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
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
