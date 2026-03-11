import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { sma } from "../../../indicators/sma.js";
import { atr } from "../../../indicators/atr.js";
import { macd } from "../../../indicators/macd.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

interface ExpansionRetestParams {
  expansionMult: StrategyParam;
  retestWindow: StrategyParam;
  consolLookback: StrategyParam;
  consolThreshold: StrategyParam;
  volMultiplier: StrategyParam;
  atrStopMult: StrategyParam;
  atrTrailMult: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: ExpansionRetestParams = {
  expansionMult: {
    value: 2, min: 1.2, max: 3.0, step: 0.2, optimizable: true,
    description: "Bar range expansion threshold (X * SMA20 range)",
  },
  retestWindow: {
    value: 8, min: 3, max: 12, step: 1, optimizable: true,
    description: "Max 15m bars to wait for retest after expansion",
  },
  consolLookback: {
    value: 10, min: 5, max: 20, step: 1, optimizable: true,
    description: "4H bars to measure consolidation range",
  },
  consolThreshold: {
    value: 3, min: 1.5, max: 5.0, step: 0.5, optimizable: true,
    description: "4H consolidation: range/ATR ratio must be below this",
  },
  volMultiplier: {
    value: 1.5, min: 1.0, max: 3.0, step: 0.25, optimizable: true,
    description: "Volume spike threshold (X * SMA20 volume)",
  },
  atrStopMult: {
    value: 3.5, min: 3.0, max: 6.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H initial stop multiplier (KB >= 3.0)",
  },
  atrTrailMult: {
    value: 2.5, min: 2.0, max: 5.0, step: 0.5, optimizable: true,
    description: "ATR(14) 1H trailing stop multiplier",
  },
  timeoutBars: {
    value: 64, min: 24, max: 96, step: 4, optimizable: true,
    description: "Forced exit after N bars to prevent funding bleed",
  },
};

interface PendingRetest {
  direction: "long" | "short";
  level: number;
  barsWaiting: number;
}

export function createExpansionRetestConsolidationMacdAtrTrail(
  paramOverrides?: Partial<Record<keyof ExpansionRetestParams, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key as keyof ExpansionRetestParams];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  let volSmaCache: number[] | null = null;
  let rangeSmaCache: number[] | null = null;
  let macdHistCache: number[] | null = null;
  let htfAtrCache1h: number[] | null = null;
  let htfAtrCache4h: number[] | null = null;
  let htf1hCandles: Candle[] | null = null;
  let htf4hCandles: Candle[] | null = null;

  let pendingRetest: PendingRetest | null = null;

  function findAtr1h(currentT: number, ref: Candle[], vals: number[]): number {
    for (let j = ref.length - 1; j >= 0; j--) {
      if (ref[j].t + MS_1H <= currentT && !isNaN(vals[j])) return vals[j];
    }
    return NaN;
  }

  function findAtr4h(currentT: number, ref: Candle[], vals: number[]): number {
    for (let j = ref.length - 1; j >= 0; j--) {
      if (ref[j].t + MS_4H <= currentT && !isNaN(vals[j])) return vals[j];
    }
    return NaN;
  }

  function getConsolRatio(currentT: number): number {
    if (!htf4hCandles || htf4hCandles.length < 15 || !htfAtrCache4h) return NaN;
    const lookback = params.consolLookback.value;

    const completedBars: Candle[] = [];
    for (let j = htf4hCandles.length - 1; j >= 0; j--) {
      if (htf4hCandles[j].t + MS_4H <= currentT) {
        completedBars.unshift(htf4hCandles[j]);
        if (completedBars.length >= lookback) break;
      }
    }
    if (completedBars.length < lookback) return NaN;

    let maxH = -Infinity, minL = Infinity;
    for (const bar of completedBars) {
      if (bar.h > maxH) maxH = bar.h;
      if (bar.l < minL) minL = bar.l;
    }
    const range = maxH - minL;

    const atr4h = findAtr4h(currentT, htf4hCandles, htfAtrCache4h);
    if (isNaN(atr4h) || atr4h === 0) return NaN;

    return range / atr4h;
  }

  return {
    name: "BTC 15m Breakout — Expansion Retest MACD ATR-Trail",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 50, "1h": 15, "4h": 30 },

    init(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      volSmaCache = sma(candles.map(c => c.v), 20);
      rangeSmaCache = sma(candles.map(c => c.h - c.l), 20);
      macdHistCache = macd(candles.map(c => c.c), 12, 26, 9).histogram;

      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htfAtrCache1h = htf1hCandles.length > 0 ? atr(htf1hCandles, 14) : null;
      htfAtrCache4h = htf4hCandles.length > 0 ? atr(htf4hCandles, 14) : null;

      pendingRetest = null;
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 40) return null;

      // Clear retest state when already in a position
      if (ctx.positionDirection) {
        pendingRetest = null;
        return null;
      }

      const close = currentCandle.c;
      const open = currentCandle.o;
      const barRange = currentCandle.h - currentCandle.l;

      const avgRange = rangeSmaCache?.[index] ?? NaN;
      const volAvg20 = volSmaCache?.[index] ?? NaN;
      const macdHist = macdHistCache?.[index] ?? NaN;

      // 1H ATR (anti-repaint: completed bar only)
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const atr1hArr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, atr1hArr);
      if (isNaN(atr1hVal)) return null;

      ctx.indicator("barRange", barRange);
      ctx.indicator("avgRange", avgRange);
      ctx.indicator("macdHist", macdHist);
      ctx.indicator("atr1h", atr1hVal);
      ctx.indicator("close", close);

      // ────── Phase 1: Check for retest entry ──────
      if (pendingRetest) {
        pendingRetest.barsWaiting++;

        if (pendingRetest.barsWaiting > params.retestWindow.value) {
          ctx.indicator("retestExpired", 1);
          pendingRetest = null;
        }
      }

      if (pendingRetest) {
        const pr = pendingRetest;
        const level = pr.level;

        ctx.indicator("retestLevel", level);
        ctx.indicator("retestBarsWaiting", pr.barsWaiting);

        let retestOk = false;
        if (pr.direction === "long") {
          // Retest: bar's low approached level, close held above
          const touched = currentCandle.l <= level;
          const held = close > level;
          ctx.track("L:retest_touch", touched, currentCandle.l, level);
          ctx.track("L:retest_hold", held, close, level);
          retestOk = touched && held;
        } else {
          // Retest: bar's high approached level, close held below
          const touched = currentCandle.h >= level;
          const held = close < level;
          ctx.track("S:retest_touch", touched, currentCandle.h, level);
          ctx.track("S:retest_hold", held, close, level);
          retestOk = touched && held;
        }

        if (retestOk) {
          // Regime: 4H consolidation
          const consolRatio = getConsolRatio(currentCandle.t);
          const consolOk = !isNaN(consolRatio) && consolRatio < params.consolThreshold.value;

          // Confirmation: MACD histogram direction
          const macdOk = pr.direction === "long"
            ? !isNaN(macdHist) && macdHist > 0
            : !isNaN(macdHist) && macdHist < 0;

          if (pr.direction === "long") {
            ctx.track("L:consol_4h", consolOk, consolRatio, params.consolThreshold.value);
            ctx.track("L:macd_positive", macdOk, macdHist, 0);
          } else {
            ctx.track("S:consol_4h", consolOk, consolRatio, params.consolThreshold.value);
            ctx.track("S:macd_negative", macdOk, macdHist, 0);
          }

          if (consolOk && macdOk) {
            const stopDist = atr1hVal * params.atrStopMult.value;
            pendingRetest = null;

            if (pr.direction === "long") {
              return {
                direction: "long",
                entryPrice: null,
                stopLoss: close - stopDist,
                takeProfits: [],
                comment: "Expansion retest long (consol+MACD)",
              };
            } else {
              return {
                direction: "short",
                entryPrice: null,
                stopLoss: close + stopDist,
                takeProfits: [],
                comment: "Expansion retest short (consol+MACD)",
              };
            }
          }
        }

        // Invalidate if price moved too far against the expected direction
        if (pr.direction === "long" && close < pr.level - atr1hVal) {
          pendingRetest = null;
        } else if (pr.direction === "short" && close > pr.level + atr1hVal) {
          pendingRetest = null;
        }
      }

      // ────── Phase 2: Detect new expansion ──────
      if (!pendingRetest) {
        if (isNaN(avgRange) || avgRange === 0) return null;

        const expansionThreshold = params.expansionMult.value * avgRange;
        const isExpansion = barRange > expansionThreshold;

        const volMult = params.volMultiplier.value;
        const volThreshold = !isNaN(volAvg20) ? volMult * volAvg20 : NaN;
        const volOk = !isNaN(volThreshold) && currentCandle.v > volThreshold;

        ctx.indicator("expansionThreshold", expansionThreshold);
        ctx.indicator("volThreshold", volThreshold);

        // Bullish expansion: close > open, close confirms breakout above prev close
        const prevClose = candles[index - 1].c;

        if (isExpansion && volOk && close > open && close > prevClose) {
          ctx.track("L:expansion", true, barRange, expansionThreshold);
          ctx.track("L:vol_spike", true, currentCandle.v, volThreshold);
          pendingRetest = {
            direction: "long",
            level: prevClose,
            barsWaiting: 0,
          };
        } else if (isExpansion && volOk && close < open && close < prevClose) {
          ctx.track("S:expansion", true, barRange, expansionThreshold);
          ctx.track("S:vol_spike", true, currentCandle.v, volThreshold);
          pendingRetest = {
            direction: "short",
            level: prevClose,
            barsWaiting: 0,
          };
        } else {
          // Track failed conditions for diagnostics
          ctx.track("L:expansion", isExpansion, barRange, expansionThreshold);
          ctx.track("L:vol_spike", volOk, currentCandle.v, volThreshold || 0);
        }
      }

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      // Timeout first (mandatory — Rule 5)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }

      // ATR trailing stop
      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const trailDist = params.atrTrailMult.value * atr1hVal;

      if (positionDirection === "long") {
        let highestHigh = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].h > highestHigh) highestHigh = candles[k].h;
        }
        const trailStop = highestHigh - trailDist;
        ctx.indicator("trailStop", trailStop);
        if (currentCandle.c < trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      } else {
        let lowestLow = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].l < lowestLow) lowestLow = candles[k].l;
        }
        const trailStop = lowestLow + trailDist;
        ctx.indicator("trailStop", trailStop);
        if (currentCandle.c > trailStop) {
          return { exit: true, comment: "ATR Trail" };
        }
      }

      return null;
    },

    getExitLevel(ctx: StrategyContext): number | null {
      const { candles, index, currentCandle, positionDirection, positionEntryPrice, positionEntryBarIndex, higherTimeframes } = ctx;
      if (!positionDirection || positionEntryBarIndex === null || positionEntryPrice === null) return null;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const trailDist = params.atrTrailMult.value * atr1hVal;

      if (positionDirection === "long") {
        let highestHigh = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].h > highestHigh) highestHigh = candles[k].h;
        }
        return highestHigh - trailDist;
      } else {
        let lowestLow = positionEntryPrice;
        for (let k = positionEntryBarIndex; k <= index; k++) {
          if (candles[k].l < lowestLow) lowestLow = candles[k].l;
        }
        return lowestLow + trailDist;
      }
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle, higherTimeframes } = ctx;

      const htf1hRef = htf1hCandles ?? higherTimeframes["1h"];
      if (!htf1hRef || htf1hRef.length < 15) return null;
      const htfAtr = htfAtrCache1h ?? atr(htf1hRef, 14);
      const atr1hVal = findAtr1h(currentCandle.t, htf1hRef, htfAtr);
      if (isNaN(atr1hVal)) return null;

      const stopDist = atr1hVal * params.atrStopMult.value;
      const close = currentCandle.c;

      if (direction === "long") {
        return {
          stopLoss: close - stopDist,
          takeProfits: [],
        };
      } else {
        return {
          stopLoss: close + stopDist,
          takeProfits: [],
        };
      }
    },
  };
}
