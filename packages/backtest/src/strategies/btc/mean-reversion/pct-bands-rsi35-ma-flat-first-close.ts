import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { rsi } from "../../../indicators/rsi.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;

// Fixed constants (not optimizable)
const RSI_PERIOD = 4; // Middle of 3-5 range (smoother than RSI(2))
const MA_REGIME_PERIOD = 50; // 50-period SMA on 1H for slope calculation
const SHORT_TIMEOUT_RATIO = 0.67; // timeout_short = timeout_long × 0.67
const VIRTUAL_STOP_ATR_MULT = 5.0; // Wide catastrophic stop for position sizing (no fixed stop)

interface PctBandsRsi35MaFlatFirstCloseParams {
  maPeriod: StrategyParam;
  bandPct: StrategyParam;
  rsiThreshLong: StrategyParam;
  maSlopeThresh: StrategyParam;
  timeoutBarsLong: StrategyParam;
}

const DEFAULT_PARAMS: PctBandsRsi35MaFlatFirstCloseParams = {
  maPeriod: {
    value: 20, min: 10, max: 40, step: 2, optimizable: true,
    description: "SMA period for percentage bands midline",
  },
  bandPct: {
    value: 1.5, min: 0.5, max: 3.0, step: 0.25, optimizable: true,
    description: "Percentage distance from SMA to upper/lower band (e.g. 1.5 = ±1.5%)",
  },
  rsiThreshLong: {
    value: 20, min: 10, max: 30, step: 5, optimizable: true,
    description: "RSI(4) must be below this for long entry (short threshold = 100 - this)",
  },
  maSlopeThresh: {
    value: 0.15, min: 0.05, max: 0.5, step: 0.05, optimizable: true,
    description: "Max absolute % change per bar of 1H SMA(50) for 'flat' regime gate",
  },
  timeoutBarsLong: {
    value: 20, min: 8, max: 32, step: 4, optimizable: true,
    description: "Forced exit after N bars for longs (shorts = N × 0.67). Safety net for first-close exit",
  },
};

export function createPctBandsRsi35MaFlatFirstClose(
  paramOverrides?: Partial<Record<keyof PctBandsRsi35MaFlatFirstCloseParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof PctBandsRsi35MaFlatFirstCloseParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // Indicator caches (populated in init)
  let smaCache: number[] | null = null;
  let rsiCache: number[] | null = null;
  let htfSmaCache1h: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let allCandles: Candle[] | null = null;

  /** Anti-repaint: find last fully-closed 1H candle value */
  function findHtf1hValue(currentT: number, htfRef: Candle[], values: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(values[j])) {
        return values[j];
      }
    }
    return NaN;
  }

  /** Anti-repaint: find last two fully-closed 1H candle values for slope calc */
  function findHtf1hSlope(currentT: number, htfRef: Candle[], values: number[]): number {
    let found = 0;
    let curr = NaN;
    let prev = NaN;
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_1H <= currentT && !isNaN(values[j])) {
        if (found === 0) { curr = values[j]; found++; }
        else if (found === 1) { prev = values[j]; found++; break; }
      }
    }
    if (found < 2 || prev === 0) return NaN;
    return ((curr - prev) / prev) * 100; // percentage change per bar
  }

  return {
    name: "BTC 15m Mean Reversion — Pct Bands RSI35 MA Flat First Close",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 50, "1h": 60 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const period = Math.round(params.maPeriod.value);
      allCandles = candles;
      smaCache = sma(candles.map((c) => c.c), period);
      rsiCache = rsi(candles.map((c) => c.c), RSI_PERIOD);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfSmaCache1h = sma(htf1hCandles.map((c) => c.c), MA_REGIME_PERIOD);
        htfAtrCache1h = atr(htf1hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { index, currentCandle, higherTimeframes } = ctx;
      const period = Math.round(params.maPeriod.value);
      if (index < period + RSI_PERIOD) return null;
      if (ctx.positionDirection) return null;

      // Previous-bar indicators (avoid look-ahead bias)
      const prev = index - 1;
      const smaVal = smaCache ? smaCache[prev] : NaN;
      const rsiVal = rsiCache ? rsiCache[prev] : NaN;
      if (isNaN(smaVal) || isNaN(rsiVal)) return null;

      // Percentage bands from SMA
      const bandPctFrac = params.bandPct.value / 100;
      const upperBand = smaVal * (1 + bandPctFrac);
      const lowerBand = smaVal * (1 - bandPctFrac);

      // HTF: 1H MA slope regime gate (anti-repaint)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 60) return null;
      const sma1hArr = htfSmaCache1h ?? sma(htf1hRef.map((c) => c.c), MA_REGIME_PERIOD);
      const maSlope = findHtf1hSlope(currentCandle.t, htf1hRef, sma1hArr);
      if (isNaN(maSlope)) return null;

      // HTF: 1H ATR for virtual stop (position sizing)
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findHtf1hValue(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      const close = currentCandle.c;
      const slopeThresh = params.maSlopeThresh.value;
      const rsiThreshLong = params.rsiThreshLong.value;
      const rsiThreshShort = 100 - rsiThreshLong; // Derived: saves 1 var
      const virtualStopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;

      // Diagnostics
      ctx.indicator("sma", smaVal);
      ctx.indicator("upperBand", upperBand);
      ctx.indicator("lowerBand", lowerBand);
      ctx.indicator("rsi4", rsiVal);
      ctx.indicator("maSlope1h", maSlope);
      ctx.indicator("atr1h", atr1hVal);

      // --- LONG: close at/below lower band + RSI(4) oversold + MA flat ---
      const longBand = ctx.track("L:below_lower_band", close <= lowerBand, close, lowerBand);
      const longRsi = ctx.track("L:rsi_oversold", rsiVal < rsiThreshLong, rsiVal, rsiThreshLong);
      const longRegime = ctx.track("L:ma_flat", Math.abs(maSlope) < slopeThresh, Math.abs(maSlope), slopeThresh);

      if (longBand && longRsi && longRegime) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - virtualStopDist,
          takeProfits: [],
          comment: "Pct band lower + RSI4 oversold + MA flat (MR long)",
        };
      }

      // --- SHORT: close at/above upper band + RSI(4) overbought + MA flat ---
      const shortBand = ctx.track("S:above_upper_band", close >= upperBand, close, upperBand);
      const shortRsi = ctx.track("S:rsi_overbought", rsiVal > rsiThreshShort, rsiVal, rsiThreshShort);
      const shortRegime = ctx.track("S:ma_flat", Math.abs(maSlope) < slopeThresh, Math.abs(maSlope), slopeThresh);

      if (shortBand && shortRsi && shortRegime) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + virtualStopDist,
          takeProfits: [],
          comment: "Pct band upper + RSI4 overbought + MA flat (MR short)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null) return null;

      const barsInTrade = ctx.index - ctx.positionEntryBarIndex;
      const timeoutLong = Math.round(params.timeoutBarsLong.value);
      const timeoutShort = Math.round(timeoutLong * SHORT_TIMEOUT_RATIO);

      // Timeout exit (mandatory — asymmetric: shorts have shorter timeout)
      if (ctx.positionDirection === "long" && barsInTrade >= timeoutLong) {
        return { exit: true, comment: "Timeout (long)" };
      }
      if (ctx.positionDirection === "short" && barsInTrade >= timeoutShort) {
        return { exit: true, comment: "Timeout (short)" };
      }

      // First-close exit — exit at first close in direction of reversion
      // Long: exit when close > entry bar's high (price reverted upward)
      // Short: exit when close < entry bar's low (price reverted downward)
      if (!allCandles) return null;
      const entryBar = allCandles[ctx.positionEntryBarIndex];
      if (!entryBar) return null;

      // Skip the entry bar itself (barsInTrade === 0)
      if (barsInTrade < 1) return null;

      const close = ctx.currentCandle.c;

      if (ctx.positionDirection === "long" && close > entryBar.h) {
        return { exit: true, comment: "First close above entry high (long)" };
      }
      if (ctx.positionDirection === "short" && close < entryBar.l) {
        return { exit: true, comment: "First close below entry low (short)" };
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      if (!ctx.positionDirection || ctx.positionEntryBarIndex === null || !allCandles) return null;
      const entryBar = allCandles[ctx.positionEntryBarIndex];
      if (!entryBar) return null;
      return ctx.positionDirection === "long" ? entryBar.h : entryBar.l;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findHtf1hValue(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * VIRTUAL_STOP_ATR_MULT;
      const close = currentCandle.c;

      if (direction === "long") {
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },
  };
}
