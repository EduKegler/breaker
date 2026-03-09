import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { donchian } from "../../../indicators/donchian.js";
import { adx as adxIndicator } from "../../../indicators/adx.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface DonchianAdxTimeoutParams {
  donchianPeriod: StrategyParam;
  adxThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: DonchianAdxTimeoutParams = {
  donchianPeriod: {
    value: 20, min: 10, max: 30, step: 2, optimizable: true,
    description: "Donchian channel period for breakout detection",
  },
  adxThreshold: {
    value: 30, min: 15, max: 50, step: 5, optimizable: true,
    description: "Max ADX(14) 4H for consolidation regime (lower = stricter filter)",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createDonchianAdxTimeout(
  paramOverrides?: Partial<Record<keyof DonchianAdxTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof DonchianAdxTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let dcCache: { upper: number[]; lower: number[] } | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf4hAdxCache: { adx: number[]; diPlus: number[]; diMinus: number[] } | null = null;
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

  function findAdx4h(currentT: number, htfRef: Candle[], htfAdx: number[]): number {
    for (let j = htfRef.length - 1; j >= 0; j--) {
      if (htfRef[j].t + MS_4H <= currentT && !isNaN(htfAdx[j])) {
        return htfAdx[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — Donchian ADX Timeout",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      dcCache = donchian(candles, params.donchianPeriod.value);
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hAdxCache = htf4hCandles.length > 0 ? adxIndicator(htf4hCandles, 14) : null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const period = params.donchianPeriod.value;
      if (index < period + 20) return null;

      // Donchian Channel on 15m (previous bar's levels = breakout reference)
      const dc = dcCache ?? donchian(candles.slice(0, index + 1), period);
      const dcUpper = dc.upper[index - 1];
      const dcLower = dc.lower[index - 1];
      if (isNaN(dcUpper) || isNaN(dcLower)) return null;

      // 1H ATR — only completed bars (anti-repaint)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr1h = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1h = findAtr1h(currentCandle.t, htf1hRef, htfAtr1h);
      if (isNaN(atr1h)) return null;

      // 4H ADX — only completed bars (anti-repaint)
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 28) return null;
      const htfAdx = htf4hAdxCache ?? adxIndicator(htf4hRef, 14);
      const adx4h = findAdx4h(currentCandle.t, htf4hRef, htfAdx.adx);
      if (isNaN(adx4h)) return null;

      const adxThresh = params.adxThreshold.value;

      // Volume SMA(20)
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const stopMult = params.atrStopMult.value;
      const stopDist = atr1h * stopMult;

      // Diagnostics
      ctx.indicator("dcUpper", dcUpper);
      ctx.indicator("dcLower", dcLower);
      ctx.indicator("close", close);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("volAvg20", volAvg20);

      // LONG: close above Donchian upper + low ADX (consolidation) + volume spike
      const longBreakout = ctx.track("L:close_above_dc", close > dcUpper, close, dcUpper);
      const longAdx = ctx.track("L:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreakout && longAdx && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "Donchian breakout long (ADX consolidation)",
        };
      }

      // SHORT: close below Donchian lower + low ADX (consolidation) + volume spike
      const shortBreakout = ctx.track("S:close_below_dc", close < dcLower, close, dcLower);
      const shortAdx = ctx.track("S:adx_consolidation", adx4h < adxThresh, adx4h, adxThresh);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreakout && shortAdx && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "Donchian breakout short (ADX consolidation)",
        };
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory)
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
