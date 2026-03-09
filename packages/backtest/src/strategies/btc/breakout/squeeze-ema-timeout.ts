import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { ema as emaIndicator } from "../../../indicators/ema.js";
import { bollingerBands } from "../../../indicators/bollinger-bands.js";
import { keltner } from "../../../indicators/keltner.js";
import { detectSqueeze } from "../../../indicators/detect-squeeze.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;
const SQUEEZE_LOOKBACK = 10;
const FRESH_RELEASE_BARS = 3;

interface SqueezeEmaTimeoutParams {
  bbKcPeriod: StrategyParam;
  kcMult: StrategyParam;
  squeezeMinBars: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  emaPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: SqueezeEmaTimeoutParams = {
  bbKcPeriod: {
    value: 20, min: 14, max: 30, step: 2, optimizable: true,
    description: "Shared period for Bollinger Bands and Keltner Channel",
  },
  kcMult: {
    value: 1.5, min: 1.0, max: 2.5, step: 0.25, optimizable: true,
    description: "Keltner Channel multiplier (KB §7.1: 1.5)",
  },
  squeezeMinBars: {
    value: 3, min: 2, max: 8, step: 1, optimizable: true,
    description: "Min bars of squeeze in last 10 bars to qualify as compression",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB §1.6 >= 3.0)",
  },
  emaPeriod: {
    value: 50, min: 20, max: 100, step: 10, optimizable: true,
    description: "EMA period on 4H for regime direction filter",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createSqueezeEmaTimeout(
  paramOverrides?: Partial<Record<keyof SqueezeEmaTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof SqueezeEmaTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let volSmaCache: number[] | null = null;
  let bbCache: ReturnType<typeof bollingerBands> | null = null;
  let kcCache: ReturnType<typeof keltner> | null = null;
  let squeezeCache: ReturnType<typeof detectSqueeze> | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf4hEmaCache: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;

  function findAtr1h(currentT: number, htfRef: Candle[], htfAtr: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(htfAtr[j])) {
        return htfAtr[j];
      }
    }
    return NaN;
  }

  function findLast4hIdx(currentT: number, htfRef: Candle[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT) {
        return j;
      }
    }
    return -1;
  }

  return {
    name: "BTC 15m Breakout — Squeeze EMA Timeout",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      volSmaCache = sma(candles.map(c => c.v), 20);

      const closes = candles.map(c => c.c);
      const period = params.bbKcPeriod.value;
      const kcMultVal = params.kcMult.value;

      bbCache = bollingerBands(closes, period, 2.0);
      kcCache = keltner(candles, period, period, kcMultVal);
      squeezeCache = detectSqueeze(bbCache, kcCache, 1);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      if (htf4hCandles.length > 0) {
        htf4hEmaCache = emaIndicator(htf4hCandles.map(c => c.c), params.emaPeriod.value);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 35) return null;

      const period = params.bbKcPeriod.value;
      const kcMultVal = params.kcMult.value;

      // --- BB / KC / Squeeze ---
      const bb = bbCache ?? bollingerBands(candles.map(c => c.c), period, 2.0);
      const kc = kcCache ?? keltner(candles, period, period, kcMultVal);
      const squeeze = squeezeCache ?? detectSqueeze(bb, kc, 1);

      // --- Squeeze lookback: count recent squeezeOn bars ---
      const minSqueezeBars = params.squeezeMinBars.value;
      let squeezeCount = 0;
      for (let k = Math.max(0, index - SQUEEZE_LOOKBACK); k < index; k++) {
        if (squeeze.squeezeOn[k]) squeezeCount++;
      }
      const hasRecentSqueeze = squeezeCount >= minSqueezeBars;
      const isReleased = !squeeze.squeezeOn[index];

      // Fresh release: squeeze was on within last FRESH_RELEASE_BARS bars
      let freshRelease = false;
      for (let k = 1; k <= FRESH_RELEASE_BARS && index - k >= 0; k++) {
        if (squeeze.squeezeOn[index - k]) { freshRelease = true; break; }
      }

      // --- KC levels ---
      const kcUpper = kc.upper[index];
      const kcLower = kc.lower[index];
      if (isNaN(kcUpper) || isNaN(kcLower)) return null;

      // --- HTF: 1H ATR (anti-repaint) ---
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // --- HTF: 4H EMA regime (anti-repaint) ---
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 30) return null;
      const ema4h = htf4hEmaCache ?? emaIndicator(htf4hRef.map(c => c.c), params.emaPeriod.value);
      const last4hIdx = findLast4hIdx(currentCandle.t, htf4hRef);
      if (last4hIdx < 0) return null;

      const emaValue = ema4h[last4hIdx];
      const htf4hClose = htf4hRef[last4hIdx].c;
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
      ctx.indicator("squeezeCount", squeezeCount);
      ctx.indicator("kcUpper", kcUpper);
      ctx.indicator("kcLower", kcLower);
      ctx.indicator("ema4h", emaValue);
      ctx.indicator("htf4hClose", htf4hClose);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("close", close);

      // --- LONG: recent squeeze + fresh release + close > KC upper + volume + EMA regime ---
      const longSqueeze = ctx.track("L:recent_squeeze", hasRecentSqueeze, squeezeCount, minSqueezeBars);
      const longRelease = ctx.track("L:squeeze_released", isReleased && freshRelease);
      const longBreakout = ctx.track("L:close_above_kc_upper", close > kcUpper, close, kcUpper);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);
      const longRegime = ctx.track("L:ema_regime", htf4hClose > emaValue, htf4hClose, emaValue);

      if (longSqueeze && longRelease && longBreakout && longVol && longRegime) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Squeeze release long",
        };
      }

      // --- SHORT: recent squeeze + fresh release + close < KC lower + volume + EMA regime ---
      const shortSqueeze = ctx.track("S:recent_squeeze", hasRecentSqueeze, squeezeCount, minSqueezeBars);
      const shortRelease = ctx.track("S:squeeze_released", isReleased && freshRelease);
      const shortBreakout = ctx.track("S:close_below_kc_lower", close < kcLower, close, kcLower);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);
      const shortRegime = ctx.track("S:ema_regime", htf4hClose < emaValue, htf4hClose, emaValue);

      if (shortSqueeze && shortRelease && shortBreakout && shortVol && shortRegime) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Squeeze release short",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      return null;
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
