import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { adx as adxIndicator } from "../../../indicators/adx.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface OrbAdxTimeoutParams {
  orbWindowBars: StrategyParam;
  adxThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: OrbAdxTimeoutParams = {
  orbWindowBars: {
    value: 2, min: 1, max: 4, step: 1, optimizable: true,
    description: "15m bars for ORB range (1=15min, 2=30min, 4=60min)",
  },
  adxThreshold: {
    value: 20, min: 15, max: 40, step: 5, optimizable: true,
    description: "4H ADX upper limit for consolidation regime (entry when ADX < threshold)",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 4.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  timeoutBars: {
    value: 48, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

export function createOrbAdxTimeout(
  paramOverrides?: Partial<Record<keyof OrbAdxTimeoutParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof OrbAdxTimeoutParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let volSmaCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;
  let htf4hAdxCache: ReturnType<typeof adxIndicator> | null = null;
  let sessionOpens: Map<number, "london" | "ny"> | null = null;

  // ORB state (mutable across bars)
  let orbHigh = NaN;
  let orbLow = NaN;
  let orbBarsCollected = 0;
  let orbArmed = false;

  // DST-aware session formatters (reused across init loop)
  const londonHourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    hour: "numeric",
    hourCycle: "h23",
  });
  const nyHourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hourCycle: "h23",
  });

  function findAtr1h(currentT: number, ref: Candle[], vals: number[]): number {
    for (let j = ref.length - 1; j >= 0; j--) {
      if (ref[j].t + MS_1H <= currentT && !isNaN(vals[j])) return vals[j];
    }
    return NaN;
  }

  function findAdx4h(currentT: number, ref: Candle[], vals: number[]): number {
    for (let j = ref.length - 1; j >= 0; j--) {
      if (ref[j].t + MS_4H <= currentT && !isNaN(vals[j])) return vals[j];
    }
    return NaN;
  }

  return {
    name: "BTC 15m Breakout — ORB ADX Timeout",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      volSmaCache = sma(candles.map(c => c.v), 20);
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htf4hAdxCache = htf4hCandles.length > 0 ? adxIndicator(htf4hCandles, 14) : null;

      // Precompute session open bar indices (DST-aware via Intl.DateTimeFormat)
      // London opens 08:00 local → UTC 07:00 (BST) or 08:00 (GMT)
      // NY opens 09:30 local → UTC 13:30 (EDT) or 14:30 (EST)
      sessionOpens = new Map();
      for (let i = 0; i < candles.length; i++) {
        const d = new Date(candles[i].t);
        const utcH = d.getUTCHours();
        const utcM = d.getUTCMinutes();

        if (utcM === 0 && (utcH === 7 || utcH === 8)) {
          const parts = londonHourFmt.formatToParts(d);
          const localH = parseInt(parts.find(p => p.type === "hour")!.value);
          if (localH === 8) {
            sessionOpens.set(i, "london");
            continue;
          }
        }

        if (utcM === 30 && (utcH === 13 || utcH === 14)) {
          const parts = nyHourFmt.formatToParts(d);
          const localH = parseInt(parts.find(p => p.type === "hour")!.value);
          if (localH === 9) {
            sessionOpens.set(i, "ny");
          }
        }
      }

      orbHigh = NaN;
      orbLow = NaN;
      orbBarsCollected = 0;
      orbArmed = false;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 30) return null;

      const windowBars = params.orbWindowBars.value;

      // Session open detected → reset ORB formation
      const session = sessionOpens?.get(index);
      if (session) {
        orbHigh = currentCandle.h;
        orbLow = currentCandle.l;
        orbBarsCollected = 1;
        orbArmed = orbBarsCollected >= windowBars;
        ctx.indicator("orbHigh", orbHigh);
        ctx.indicator("orbLow", orbLow);
        ctx.indicator("orbArmed", orbArmed ? 1 : 0);
        return null;
      }

      // Still collecting ORB range bars
      if (orbBarsCollected > 0 && !orbArmed) {
        orbHigh = Math.max(orbHigh, currentCandle.h);
        orbLow = Math.min(orbLow, currentCandle.l);
        orbBarsCollected++;
        if (orbBarsCollected >= windowBars) orbArmed = true;
        ctx.indicator("orbHigh", orbHigh);
        ctx.indicator("orbLow", orbLow);
        ctx.indicator("orbArmed", orbArmed ? 1 : 0);
        return null;
      }

      // Not armed — no ORB range established
      if (!orbArmed || isNaN(orbHigh) || isNaN(orbLow)) return null;

      ctx.indicator("orbHigh", orbHigh);
      ctx.indicator("orbLow", orbLow);
      ctx.indicator("orbArmed", 1);

      // 1H ATR for stop (anti-repaint: completed bar only)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      // 4H ADX regime filter (anti-repaint: completed bar only)
      const htf4hRef = htf4hCandles ?? higherTimeframes["4h"];
      if (!htf4hRef || htf4hRef.length < 28) return null;
      const adxData = htf4hAdxCache ?? adxIndicator(htf4hRef, 14);
      const adx4h = findAdx4h(currentCandle.t, htf4hRef, adxData.adx);
      if (isNaN(adx4h)) return null;

      // Volume SMA(20)
      const volArr = volSmaCache ?? sma(candles.slice(0, index + 1).map(c => c.v), 20);
      const volAvg20 = volArr[index];
      const volMult = params.volMultiplier.value;
      const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;

      const close = currentCandle.c;
      const adxThresh = params.adxThreshold.value;
      const stopDist = atr1hVal * params.atrStopMult.value;

      ctx.indicator("atr1h", atr1hVal);
      ctx.indicator("adx4h", adx4h);
      ctx.indicator("volAvg20", volAvg20);

      // LONG: close above ORB high + ADX consolidation + volume spike
      const longBreak = ctx.track("L:close_above_orb", close > orbHigh, close, orbHigh);
      const longAdx = ctx.track("L:adx_consol", adx4h < adxThresh, adx4h, adxThresh);
      const longVol = ctx.track("L:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (longBreak && longAdx && longVol) {
        return {
          direction: "long",
          entryPrice: null,
          stopLoss: close - stopDist,
          takeProfits: [],
          comment: "ORB long (ADX consol)",
        };
      }

      // SHORT: close below ORB low + ADX consolidation + volume spike
      const shortBreak = ctx.track("S:close_below_orb", close < orbLow, close, orbLow);
      const shortAdx = ctx.track("S:adx_consol", adx4h < adxThresh, adx4h, adxThresh);
      const shortVol = ctx.track("S:vol_spike", !isNaN(volThreshold) && currentCandle.v > volThreshold, currentCandle.v, volThreshold);

      if (shortBreak && shortAdx && shortVol) {
        return {
          direction: "short",
          entryPrice: null,
          stopLoss: close + stopDist,
          takeProfits: [],
          comment: "ORB short (ADX consol)",
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
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * params.atrStopMult.value;
      const close = currentCandle.c;

      return direction === "long"
        ? { stopLoss: close - stopDist, takeProfits: [] }
        : { stopLoss: close + stopDist, takeProfits: [] };
    },
  };
}
