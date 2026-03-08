import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { bollingerBands, type BollingerBandsResult } from "../../../indicators/bollinger-bands.js";
import { keltner, type KeltnerResult } from "../../../indicators/keltner.js";
import { donchian, type DonchianResult } from "../../../indicators/donchian.js";
import { adx as adxIndicator, type AdxResult } from "../../../indicators/adx.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface SqueezeAdxTrailDcParams {
  bbKcPeriod: StrategyParam;
  kcMult: StrategyParam;
  adxThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  trailDcPeriod: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: SqueezeAdxTrailDcParams = {
  bbKcPeriod: { value: 20, min: 14, max: 30, step: 2, optimizable: true, description: "BB and KC shared period" },
  kcMult: { value: 1.75, min: 1.0, max: 2.5, step: 0.25, optimizable: true, description: "Keltner Channel ATR multiplier" },
  adxThreshold: { value: 30, min: 15, max: 40, step: 5, optimizable: true, description: "ADX(14) 4H threshold — below = consolidation" },
  volMultiplier: { value: 2.0, min: 1.0, max: 3.0, step: 0.25, optimizable: true, description: "Volume spike threshold (X * SMA20 volume)" },
  atrStopMult: { value: 3.0, min: 3.0, max: 6.0, step: 0.5, optimizable: true, description: "ATR(14) 1H stop multiplier (KB §1.6 >= 3.0)" },
  trailDcPeriod: { value: 10, min: 5, max: 25, step: 5, optimizable: true, description: "Donchian trailing exit period (fast channel)" },
  timeoutBars: { value: 48, min: 24, max: 96, step: 4, optimizable: true, description: "Forced exit after N bars to prevent funding bleed" },
};

export function createSqueezeAdxTrailDc(
  paramOverrides?: Partial<Record<keyof SqueezeAdxTrailDcParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof SqueezeAdxTrailDcParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let bbCache: BollingerBandsResult | null = null;
  let kcCache: KeltnerResult | null = null;
  let trailDcCache: DonchianResult | null = null;
  let volSmaCache: number[] | null = null;
  let htfAtrCache: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htf4hAdxCache: AdxResult | null = null;

  return {
    name: "BTC 15m Breakout — Squeeze ADX Trail-DC",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      const period = params.bbKcPeriod.value;
      const closes = candles.map(c => c.c);

      bbCache = bollingerBands(closes, period);
      kcCache = keltner(candles, period, period, params.kcMult.value);
      trailDcCache = donchian(candles, params.trailDcPeriod.value);

      const volumes = candles.map(c => c.v);
      volSmaCache = sma(volumes, 20);

      htf1hCandles = higherTimeframes["1h"] ?? [];
      if (htf1hCandles.length > 0) {
        htfAtrCache = atr(htf1hCandles, 14);
      }

      htf4hCandles = higherTimeframes["4h"] ?? [];
      if (htf4hCandles.length > 0) {
        htf4hAdxCache = adxIndicator(htf4hCandles, 14);
      }
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      const period = params.bbKcPeriod.value;
      if (index < period + 1) return null;

      // BB and KC on 15m closes
      const bb = bbCache ?? bollingerBands(candles.slice(0, index + 1).map(c => c.c), period);
      const kc = kcCache ?? keltner(candles.slice(0, index + 1), period, period, params.kcMult.value);

      const prevBbUpper = bb.upper[index - 1];
      const prevBbLower = bb.lower[index - 1];
      const prevKcUpper = kc.upper[index - 1];
      const prevKcLower = kc.lower[index - 1];

      if (isNaN(prevBbUpper) || isNaN(prevKcUpper)) return null;

      // Squeeze: BB fully inside KC on previous bar
      const prevSqueeze = prevBbUpper <= prevKcUpper && prevBbLower >= prevKcLower;

      // Volume SMA(20)
      const volSma = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volSma[index];

      // 1H ATR — only completed bars (anti-repaint)
      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      // 4H ADX — only completed bars (anti-repaint)
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 28) return null;
      const htfAdx = htf4hAdxCache ?? adxIndicator(htf4hRef, 14);
      let adx4h = NaN;
      for (let j = htf4hRef.length - 1; j >= 0; j--) {
        if (htf4hRef[j].t + MS_4H <= currentCandle.t && !isNaN(htfAdx.adx[j])) {
          adx4h = htfAdx.adx[j];
          break;
        }
      }
      if (isNaN(adx4h)) return null;

      const close = currentCandle.c;
      const volMult = params.volMultiplier.value;
      const stopMult = params.atrStopMult.value;
      const adxThresh = params.adxThreshold.value;
      const stopDist = atr1h * stopMult;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      ctx.indicator("close", close);
      ctx.indicator("bbUpper", prevBbUpper);
      ctx.indicator("bbLower", prevBbLower);
      ctx.indicator("kcUpper", prevKcUpper);
      ctx.indicator("kcLower", prevKcLower);
      ctx.indicator("atr1h", atr1h);
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("volAvg20", volAvg20);
      ctx.indicator("squeeze", prevSqueeze ? 1 : 0);

      // Regime: ADX(14) on 4H below threshold = consolidation (pre-breakout)
      const lowAdx = adx4h < adxThresh;

      // LONG: squeeze on prev bar + close above prev KC upper + low ADX + volume spike
      const longSqueeze = ctx.track("L:squeeze_on", prevSqueeze);
      const longBreakout = ctx.track("L:close_above_kc", close > prevKcUpper, close, prevKcUpper);
      const longRegime = ctx.track("L:low_adx", lowAdx, adx4h, adxThresh);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longSqueeze && longBreakout && longRegime && longVol) {
        const sl = close - stopDist;
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "Squeeze breakout long",
        };
      }

      // SHORT: squeeze on prev bar + close below prev KC lower + low ADX + volume spike
      const shortSqueeze = ctx.track("S:squeeze_on", prevSqueeze);
      const shortBreakout = ctx.track("S:close_below_kc", close < prevKcLower, close, prevKcLower);
      const shortRegime = ctx.track("S:low_adx", lowAdx, adx4h, adxThresh);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortSqueeze && shortBreakout && shortRegime && shortVol) {
        const sl = close + stopDist;
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: sl,
          takeProfits: [],
          comment: "Squeeze breakout short",
        };
      }

      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htfCandlesRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htfCandlesRef || htfCandlesRef.length < 15) return null;
      const htfAtr = htfAtrCache ?? atr(htfCandlesRef, 14);
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      const stopMult = params.atrStopMult.value;
      const close = currentCandle.c;
      const stopDist = atr1h * stopMult;

      if (direction === "long") {
        return { stopLoss: close - stopDist, takeProfits: [] };
      } else {
        return { stopLoss: close + stopDist, takeProfits: [] };
      }
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout check first (mandatory)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // Donchian trailing exit — fast channel
      const trailPeriod = params.trailDcPeriod.value;
      if (index < trailPeriod) return null;

      const dc = trailDcCache ?? donchian(candles.slice(0, index + 1), trailPeriod);
      const prevLower = dc.lower[index - 1];
      const prevUpper = dc.upper[index - 1];
      const close = currentCandle.c;

      if (positionDirection === "long" && !isNaN(prevLower) && close < prevLower) {
        return { exit: true, comment: "Trail DC lower" };
      }
      if (positionDirection === "short" && !isNaN(prevUpper) && close > prevUpper) {
        return { exit: true, comment: "Trail DC upper" };
      }

      return null;
    },
  };
}
