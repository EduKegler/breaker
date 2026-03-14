import type { Candle } from "../../../types/candle.js";
import type { Strategy, StrategyContext, StrategyParam, Signal } from "../../../types/strategy.js";
import { atr } from "../../../indicators/atr.js";

const MS_1H = 3_600_000;
const MS_4H = 14_400_000;

// Fixed non-tunable constants (KB rule 6 — house rules, not optimizable)
const ATR_BUFFER = 0.2;
const STOP_HARD_CAP = 2.5;
const ATR_1H_PERIOD = 14;
const FRACTAL_RIGHT = 1;
const MIN_RR = 1.0;

// Candlestick pattern thresholds (KB rule 3 — canonical, non-tunable, 0 vars)
const ENGULFING_BODY_RATIO = 0.60;
const ENGULFING_MIN_BODY_RATIO = 0.10;
const HAMMER_WICK_MULT = 2;
const HAMMER_MIN_BODY_RATIO = 0.10;
const HAMMER_BODY_ZONE_PCT = 0.30;

interface SwingPoint {
  index: number;
  price: number;
  time: number;
}

interface HhhlFibCandleFixedRrParams {
  swingLookback: StrategyParam;
  fibShallow: StrategyParam;
  fibDeep: StrategyParam;
  rrTarget: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: HhhlFibCandleFixedRrParams = {
  swingLookback: {
    value: 2, min: 2, max: 6, step: 1, optimizable: true,
    description: "Fractal lookback on 4H for swing detection (left bars)",
  },
  fibShallow: {
    value: 0.382, min: 0.15, max: 0.50, step: 0.025, optimizable: true,
    description: "Shallow Fib boundary (minimum retracement to enter zone)",
  },
  fibDeep: {
    value: 0.618, min: 0.50, max: 0.90, step: 0.025, optimizable: true,
    description: "Deep Fib boundary (maximum retracement before invalidation)",
  },
  rrTarget: {
    value: 2.0, min: 1.5, max: 4.0, step: 0.25, optimizable: true,
    description: "Fixed R:R target — TP at N × risk distance from entry",
  },
  timeoutBars: {
    value: 32, min: 16, max: 64, step: 4, optimizable: true,
    description: "Timeout exit in 15m bars (32 = 8h)",
  },
};

// --- Canonical candlestick patterns (KB rule 3 — fixed, 0 vars) ---

function isBullishEngulfing(curr: Candle, prev: Candle): boolean {
  const body = Math.abs(curr.c - curr.o);
  const range = curr.h - curr.l;
  if (range <= 0 || curr.c <= curr.o) return false;
  if (body / range < ENGULFING_BODY_RATIO) return false;
  if (body / range < ENGULFING_MIN_BODY_RATIO) return false;
  const currLow = Math.min(curr.o, curr.c);
  const currHigh = Math.max(curr.o, curr.c);
  const prevLow = Math.min(prev.o, prev.c);
  const prevHigh = Math.max(prev.o, prev.c);
  return currLow <= prevLow && currHigh >= prevHigh;
}

function isBearishEngulfing(curr: Candle, prev: Candle): boolean {
  const body = Math.abs(curr.c - curr.o);
  const range = curr.h - curr.l;
  if (range <= 0 || curr.c >= curr.o) return false;
  if (body / range < ENGULFING_BODY_RATIO) return false;
  if (body / range < ENGULFING_MIN_BODY_RATIO) return false;
  const currLow = Math.min(curr.o, curr.c);
  const currHigh = Math.max(curr.o, curr.c);
  const prevLow = Math.min(prev.o, prev.c);
  const prevHigh = Math.max(prev.o, prev.c);
  return currLow <= prevLow && currHigh >= prevHigh;
}

function isBullishHammer(candle: Candle): boolean {
  const body = Math.abs(candle.c - candle.o);
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  if (body / range < HAMMER_MIN_BODY_RATIO) return false;
  const lowerWick = Math.min(candle.o, candle.c) - candle.l;
  if (lowerWick < HAMMER_WICK_MULT * body) return false;
  const bodyBottom = Math.min(candle.o, candle.c);
  return bodyBottom >= candle.l + (1 - HAMMER_BODY_ZONE_PCT) * range;
}

function isBearishHammer(candle: Candle): boolean {
  const body = Math.abs(candle.c - candle.o);
  const range = candle.h - candle.l;
  if (range <= 0) return false;
  if (body / range < HAMMER_MIN_BODY_RATIO) return false;
  const upperWick = candle.h - Math.max(candle.o, candle.c);
  if (upperWick < HAMMER_WICK_MULT * body) return false;
  const bodyTop = Math.max(candle.o, candle.c);
  return bodyTop <= candle.l + HAMMER_BODY_ZONE_PCT * range;
}

// -------------------------------------------------------------------

export function createHhhlFibCandleFixedRr(
  paramOverrides?: Partial<Record<string, number>>,
): Strategy {
  const params: Record<string, StrategyParam> = {};
  for (const [key, defaultParam] of Object.entries(DEFAULT_PARAMS)) {
    const override = paramOverrides?.[key];
    params[key] = { ...defaultParam, value: override ?? defaultParam.value };
  }

  // HTF caches (populated in init)
  let htf4hCandles: Candle[] = [];
  let htf1hCandles: Candle[] = [];
  let htf1hAtrCache: number[] | null = null;

  // Swing caches (populated in init via detectSwings)
  let swingHighs: SwingPoint[] = [];
  let swingLows: SwingPoint[] = [];

  // Pullback tracking state
  let inPullbackZone = false;
  let pullbackDirection: "long" | "short" | null = null;
  let activeSwingHigh: SwingPoint | null = null;
  let activeSwingLow: SwingPoint | null = null;

  function resetPullback(): void {
    inPullbackZone = false;
    pullbackDirection = null;
    activeSwingHigh = null;
    activeSwingLow = null;
  }

  function detectSwings(candles: Candle[], lookback: number): void {
    swingHighs = [];
    swingLows = [];
    for (let i = lookback; i < candles.length - FRACTAL_RIGHT; i++) {
      let isHigh = true;
      let isLow = true;
      for (let j = i - lookback; j < i; j++) {
        if (candles[j].h >= candles[i].h) isHigh = false;
        if (candles[j].l <= candles[i].l) isLow = false;
      }
      for (let j = i + 1; j <= i + FRACTAL_RIGHT; j++) {
        if (candles[j].h >= candles[i].h) isHigh = false;
        if (candles[j].l <= candles[i].l) isLow = false;
      }
      if (isHigh) swingHighs.push({ index: i, price: candles[i].h, time: candles[i].t });
      if (isLow) swingLows.push({ index: i, price: candles[i].l, time: candles[i].t });
    }
  }

  // Anti-repaint: swing confirmed only when BOTH the swing bar AND
  // the right-confirmation bar are fully closed
  function getClosedSwingHighs(currentT: number): SwingPoint[] {
    return swingHighs.filter(s => {
      const confirmIdx = s.index + FRACTAL_RIGHT;
      if (confirmIdx >= htf4hCandles.length) return false;
      return htf4hCandles[confirmIdx].t + MS_4H <= currentT;
    });
  }

  function getClosedSwingLows(currentT: number): SwingPoint[] {
    return swingLows.filter(s => {
      const confirmIdx = s.index + FRACTAL_RIGHT;
      if (confirmIdx >= htf4hCandles.length) return false;
      return htf4hCandles[confirmIdx].t + MS_4H <= currentT;
    });
  }

  function findHtf1hAtr(currentT: number): number {
    if (!htf1hAtrCache) return NaN;
    for (let j = htf1hCandles.length - 1; j >= 0; j--) {
      if (htf1hCandles[j].t + MS_1H <= currentT && !isNaN(htf1hAtrCache[j])) {
        return htf1hAtrCache[j];
      }
    }
    return NaN;
  }

  return {
    name: "BTC 15m Pullback — HHHL Fib Candle Fixed RR",
    params,
    requiredTimeframes: ["1h", "4h"],
    requiredWarmup: { source: 20, "1h": 15, "4h": 40 },

    init(_candles: Candle[], higherTimeframes: Record<string, Candle[]>): void {
      htf4hCandles = higherTimeframes["4h"] ?? [];
      htf1hCandles = higherTimeframes["1h"] ?? [];
      htf1hAtrCache = htf1hCandles.length > 0
        ? atr(htf1hCandles, ATR_1H_PERIOD)
        : null;
      if (htf4hCandles.length > params.swingLookback.value + FRACTAL_RIGHT) {
        detectSwings(htf4hCandles, params.swingLookback.value);
      }
      resetPullback();
    },

    onCandle(ctx: StrategyContext): Signal | null {
      const { candles, index, currentCandle } = ctx;
      if (index < 2) return null;

      const prevCandle = candles[index - 1];
      const atr1h = findHtf1hAtr(currentCandle.t);
      if (isNaN(atr1h) || atr1h <= 0) return null;

      // --- Closed 4H swings (anti-repaint) ---
      const closedHighs = getClosedSwingHighs(currentCandle.t);
      const closedLows = getClosedSwingLows(currentCandle.t);
      if (closedHighs.length < 2 || closedLows.length < 2) return null;

      const lastSH = closedHighs[closedHighs.length - 1];
      const prevSH = closedHighs[closedHighs.length - 2];
      const lastSL = closedLows[closedLows.length - 1];
      const prevSL = closedLows[closedLows.length - 2];

      // --- HH/HL or LH/LL trend structure ---
      const isUptrend = lastSH.price > prevSH.price && lastSL.price > prevSL.price;
      const isDowntrend = lastSH.price < prevSH.price && lastSL.price < prevSL.price;

      ctx.indicator("lastSH", lastSH.price);
      ctx.indicator("prevSH", prevSH.price);
      ctx.indicator("lastSL", lastSL.price);
      ctx.indicator("prevSL", prevSL.price);
      ctx.indicator("atr1h", atr1h);

      const close = currentCandle.c;
      const fibShallow = params.fibShallow.value;
      const fibDeep = params.fibDeep.value;
      const rrTarget = params.rrTarget.value;

      // --- Invalidate stale pullback ---
      if (inPullbackZone) {
        const trendLost =
          (pullbackDirection === "long" && !isUptrend) ||
          (pullbackDirection === "short" && !isDowntrend);
        const swingsChanged =
          (activeSwingHigh && lastSH.index !== activeSwingHigh.index) ||
          (activeSwingLow && lastSL.index !== activeSwingLow.index);
        if (trendLost || swingsChanged) resetPullback();
      }

      // ============= LONG (uptrend pullback) =============
      if (isUptrend) {
        const swingRange = lastSH.price - lastSL.price;
        if (swingRange <= 0) return null;

        const fibShallowPrice = lastSH.price - fibShallow * swingRange;
        const fibDeepPrice = lastSH.price - fibDeep * swingRange;
        const inFibZone = close >= fibDeepPrice && close <= fibShallowPrice;

        ctx.indicator("L:fibShallow", fibShallowPrice);
        ctx.indicator("L:fibDeep", fibDeepPrice);

        // Invalidate if pullback went too deep or trend already resumed
        if (inPullbackZone && pullbackDirection === "long") {
          if (close < fibDeepPrice || close > lastSH.price) {
            resetPullback();
          }
        }

        // Enter pullback zone (need >=1 bar before confirmation)
        if (!inPullbackZone && inFibZone) {
          const entered = ctx.track("L:enter_fib_zone", true, close, fibShallowPrice);
          if (entered) {
            inPullbackZone = true;
            pullbackDirection = "long";
            activeSwingHigh = lastSH;
            activeSwingLow = lastSL;
            return null;
          }
        }

        // Check candlestick confirmation
        if (inPullbackZone && pullbackDirection === "long" && activeSwingHigh && activeSwingLow) {
          const engulfing = isBullishEngulfing(currentCandle, prevCandle);
          const hammer = isBullishHammer(currentCandle);
          const confirmed = ctx.track("L:candle_confirm", engulfing || hammer,
            engulfing ? 1 : hammer ? 2 : 0, 1);

          if (confirmed) {
            // Stop below Fib deep level + buffer (KB rule 6b for Fib variant)
            const activeRange = activeSwingHigh.price - activeSwingLow.price;
            const activeFibDeep = activeSwingHigh.price - fibDeep * activeRange;
            const stopPrice = activeFibDeep - ATR_BUFFER * atr1h;
            const stopDist = close - stopPrice;

            const withinCap = ctx.track("L:stop_within_cap",
              stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
            const validStop = ctx.track("L:stop_positive", stopDist > 0, stopDist, 0);

            if (withinCap && validStop) {
              // Fixed R:R exit — TP at rrTarget × risk distance
              const tpPrice = close + rrTarget * stopDist;
              const rr = rrTarget;
              const rrOk = ctx.track("L:rr_filter", rr >= MIN_RR, rr, MIN_RR);

              if (rrOk) {
                const retracePct = ((activeSwingHigh.price - close) / activeRange * 100).toFixed(0);
                resetPullback();
                return {
                  direction: "long",
                  entryPrice: null,
                  stopLoss: stopPrice,
                  takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
                  comment: `Pullback long: ${engulfing ? "engulfing" : "hammer"} at Fib ${retracePct}% RR=${rrTarget}`,
                };
              }
            }
            resetPullback();
            return null;
          }
        }
      }

      // ============= SHORT (downtrend pullback) =============
      if (isDowntrend) {
        const swingRange = lastSH.price - lastSL.price;
        if (swingRange <= 0) return null;

        const fibShallowPrice = lastSL.price + fibShallow * swingRange;
        const fibDeepPrice = lastSL.price + fibDeep * swingRange;
        const inFibZone = close >= fibShallowPrice && close <= fibDeepPrice;

        ctx.indicator("S:fibShallow", fibShallowPrice);
        ctx.indicator("S:fibDeep", fibDeepPrice);

        if (inPullbackZone && pullbackDirection === "short") {
          if (close > fibDeepPrice || close < lastSL.price) {
            resetPullback();
          }
        }

        if (!inPullbackZone && inFibZone) {
          const entered = ctx.track("S:enter_fib_zone", true, close, fibShallowPrice);
          if (entered) {
            inPullbackZone = true;
            pullbackDirection = "short";
            activeSwingHigh = lastSH;
            activeSwingLow = lastSL;
            return null;
          }
        }

        if (inPullbackZone && pullbackDirection === "short" && activeSwingHigh && activeSwingLow) {
          const engulfing = isBearishEngulfing(currentCandle, prevCandle);
          const hammer = isBearishHammer(currentCandle);
          const confirmed = ctx.track("S:candle_confirm", engulfing || hammer,
            engulfing ? 1 : hammer ? 2 : 0, 1);

          if (confirmed) {
            const activeRange = activeSwingHigh.price - activeSwingLow.price;
            const activeFibDeep = activeSwingLow.price + fibDeep * activeRange;
            const stopPrice = activeFibDeep + ATR_BUFFER * atr1h;
            const stopDist = stopPrice - close;

            const withinCap = ctx.track("S:stop_within_cap",
              stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
            const validStop = ctx.track("S:stop_positive", stopDist > 0, stopDist, 0);

            if (withinCap && validStop) {
              // Fixed R:R exit — TP at rrTarget × risk distance
              const tpPrice = close - rrTarget * stopDist;
              const rr = rrTarget;
              const rrOk = ctx.track("S:rr_filter", rr >= MIN_RR, rr, MIN_RR);

              if (rrOk) {
                const retracePct = ((close - activeSwingLow.price) / activeRange * 100).toFixed(0);
                resetPullback();
                return {
                  direction: "short",
                  entryPrice: null,
                  stopLoss: stopPrice,
                  takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
                  comment: `Pullback short: ${engulfing ? "engulfing" : "hammer"} at Fib ${retracePct}% RR=${rrTarget}`,
                };
              }
            }
            resetPullback();
            return null;
          }
        }
      }

      // No trend — reset any stale pullback
      if (inPullbackZone && !isUptrend && !isDowntrend) resetPullback();

      return null;
    },

    shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;

      // Timeout first (mandatory — Rule 7)
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }
      return null;
    },

    computeLevels(ctx: StrategyContext, direction: "long" | "short") {
      const { currentCandle } = ctx;
      const atr1h = findHtf1hAtr(currentCandle.t);
      if (isNaN(atr1h) || atr1h <= 0) return null;

      const closedHighs = getClosedSwingHighs(currentCandle.t);
      const closedLows = getClosedSwingLows(currentCandle.t);
      if (closedHighs.length < 1 || closedLows.length < 1) return null;

      const lastSH = closedHighs[closedHighs.length - 1];
      const lastSL = closedLows[closedLows.length - 1];
      const swingRange = lastSH.price - lastSL.price;
      if (swingRange <= 0) return null;

      const fibDeep = params.fibDeep.value;
      const rrTarget = params.rrTarget.value;
      const close = currentCandle.c;

      if (direction === "long") {
        const fibDeepPrice = lastSH.price - fibDeep * swingRange;
        const stopPrice = fibDeepPrice - ATR_BUFFER * atr1h;
        const stopDist = close - stopPrice;
        if (stopDist > STOP_HARD_CAP * atr1h || stopDist <= 0) return null;
        const tpPrice = close + rrTarget * stopDist;
        return {
          stopLoss: stopPrice,
          takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
        };
      }
      const fibDeepPrice = lastSL.price + fibDeep * swingRange;
      const stopPrice = fibDeepPrice + ATR_BUFFER * atr1h;
      const stopDist = stopPrice - close;
      if (stopDist > STOP_HARD_CAP * atr1h || stopDist <= 0) return null;
      const tpPrice = close - rrTarget * stopDist;
      return {
        stopLoss: stopPrice,
        takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
      };
    },

    getExitLevel(_ctx: StrategyContext): number | null {
      return null;
    },
  };
}
