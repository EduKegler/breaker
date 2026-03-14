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
const STALE_BARS = 30;

interface SwingPoint {
  index: number;
  price: number;
  time: number;
}

interface HhhlFibCloseBeyondSwingParams {
  swingLookback: StrategyParam;
  fibShallow: StrategyParam;
  fibDeep: StrategyParam;
  timeoutBars: StrategyParam;
}

const DEFAULT_PARAMS: HhhlFibCloseBeyondSwingParams = {
  swingLookback: {
    value: 2, min: 2, max: 6, step: 1, optimizable: true,
    description: "Fractal lookback on 4H for swing detection (left bars)",
  },
  fibShallow: {
    value: 0.236, min: 0.15, max: 0.50, step: 0.025, optimizable: true,
    description: "Shallow Fib boundary (minimum retracement to enter zone)",
  },
  fibDeep: {
    value: 0.618, min: 0.50, max: 0.90, step: 0.025, optimizable: true,
    description: "Deep Fib boundary (maximum retracement before invalidation)",
  },
  timeoutBars: {
    value: 32, min: 16, max: 64, step: 4, optimizable: true,
    description: "Timeout exit in 15m bars (32 = 8h)",
  },
};

export function createHhhlFibCloseBeyondSwing(
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
  let pullbackHigh = -Infinity;
  let pullbackLow = Infinity;
  let activeSwingHigh: SwingPoint | null = null;
  let activeSwingLow: SwingPoint | null = null;
  let zoneEntryIndex = -1;

  function resetPullback(): void {
    inPullbackZone = false;
    pullbackDirection = null;
    pullbackHigh = -Infinity;
    pullbackLow = Infinity;
    activeSwingHigh = null;
    activeSwingLow = null;
    zoneEntryIndex = -1;
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
    name: "BTC 15m Pullback — HHHL Fib Close Beyond Swing",
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
      const { index, currentCandle } = ctx;
      if (index < 2) return null;

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

      // --- Invalidate stale/broken pullback ---
      if (inPullbackZone) {
        const trendLost =
          (pullbackDirection === "long" && !isUptrend) ||
          (pullbackDirection === "short" && !isDowntrend);
        const stale = index - zoneEntryIndex > STALE_BARS;
        if (trendLost || stale) resetPullback();
      }

      // ============= LONG (uptrend pullback) =============
      if (isUptrend) {
        const swingRange = lastSH.price - lastSL.price;
        if (swingRange > 0) {
          const fibShallowPrice = lastSH.price - fibShallow * swingRange;
          const fibDeepPrice = lastSH.price - fibDeep * swingRange;
          const inFibZone = close >= fibDeepPrice && close <= fibShallowPrice;

          ctx.indicator("L:fibShallow", fibShallowPrice);
          ctx.indicator("L:fibDeep", fibDeepPrice);

          // Invalidate if pullback too deep or price already past swing high
          if (inPullbackZone && pullbackDirection === "long" && activeSwingHigh && activeSwingLow) {
            const activeFibDeepPrice = activeSwingHigh.price - fibDeep * (activeSwingHigh.price - activeSwingLow.price);
            if (close < activeFibDeepPrice || close > activeSwingHigh.price) {
              resetPullback();
            }
          }

          // Enter pullback zone (need >= 1 bar before confirmation)
          if (!inPullbackZone && inFibZone) {
            const entered = ctx.track("L:enter_fib_zone", true, close, fibShallowPrice);
            if (entered) {
              inPullbackZone = true;
              pullbackDirection = "long";
              pullbackHigh = currentCandle.h;
              pullbackLow = currentCandle.l;
              activeSwingHigh = lastSH;
              activeSwingLow = lastSL;
              zoneEntryIndex = index;
              return null;
            }
          }

          // Close-beyond confirmation (structural — KB rule 3a)
          // pullbackHigh excludes current bar (updated AFTER check)
          if (inPullbackZone && pullbackDirection === "long" && activeSwingHigh && activeSwingLow) {
            const closeBeyond = close > pullbackHigh;
            const confirmed = ctx.track("L:close_beyond", closeBeyond, close, pullbackHigh);

            if (confirmed) {
              // Stop below Fib deep level + buffer (KB rule 6b for Fib variant)
              const activeRange = activeSwingHigh.price - activeSwingLow.price;
              const activeFibDeepPrice = activeSwingHigh.price - fibDeep * activeRange;
              const stopPrice = activeFibDeepPrice - ATR_BUFFER * atr1h;
              const stopDist = close - stopPrice;

              const withinCap = ctx.track("L:stop_within_cap", stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
              const validStop = ctx.track("L:stop_positive", stopDist > 0, stopDist, 0);

              if (withinCap && validStop) {
                // TP at prior swing high (swing exit)
                const tpPrice = activeSwingHigh.price;
                const tpDist = tpPrice - close;
                const rr = tpDist / stopDist;
                const rrOk = ctx.track("L:rr_filter", rr >= MIN_RR, rr, MIN_RR);

                if (rrOk) {
                  const retracePct = ((activeSwingHigh.price - close) / activeRange * 100).toFixed(0);
                  resetPullback();
                  return {
                    direction: "long",
                    entryPrice: null,
                    stopLoss: stopPrice,
                    takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
                    comment: `Pullback long: close-beyond at Fib ${retracePct}%`,
                  };
                }
              }
              resetPullback();
              return null;
            }

            // Update extremes for next bar (after confirmation check)
            pullbackHigh = Math.max(pullbackHigh, currentCandle.h);
            pullbackLow = Math.min(pullbackLow, currentCandle.l);
          }
        }
      }

      // ============= SHORT (downtrend pullback) =============
      if (isDowntrend) {
        const swingRange = lastSH.price - lastSL.price;
        if (swingRange > 0) {
          const fibShallowPrice = lastSL.price + fibShallow * swingRange;
          const fibDeepPrice = lastSL.price + fibDeep * swingRange;
          const inFibZone = close >= fibShallowPrice && close <= fibDeepPrice;

          ctx.indicator("S:fibShallow", fibShallowPrice);
          ctx.indicator("S:fibDeep", fibDeepPrice);

          if (inPullbackZone && pullbackDirection === "short" && activeSwingHigh && activeSwingLow) {
            const activeFibDeepPrice = activeSwingLow.price + fibDeep * (activeSwingHigh.price - activeSwingLow.price);
            if (close > activeFibDeepPrice || close < activeSwingLow.price) {
              resetPullback();
            }
          }

          if (!inPullbackZone && inFibZone) {
            const entered = ctx.track("S:enter_fib_zone", true, close, fibShallowPrice);
            if (entered) {
              inPullbackZone = true;
              pullbackDirection = "short";
              pullbackHigh = currentCandle.h;
              pullbackLow = currentCandle.l;
              activeSwingHigh = lastSH;
              activeSwingLow = lastSL;
              zoneEntryIndex = index;
              return null;
            }
          }

          // Close-beyond for shorts: close below pullback low
          if (inPullbackZone && pullbackDirection === "short" && activeSwingHigh && activeSwingLow) {
            const closeBeyond = close < pullbackLow;
            const confirmed = ctx.track("S:close_beyond", closeBeyond, close, pullbackLow);

            if (confirmed) {
              const activeRange = activeSwingHigh.price - activeSwingLow.price;
              const activeFibDeepPrice = activeSwingLow.price + fibDeep * activeRange;
              const stopPrice = activeFibDeepPrice + ATR_BUFFER * atr1h;
              const stopDist = stopPrice - close;

              const withinCap = ctx.track("S:stop_within_cap", stopDist <= STOP_HARD_CAP * atr1h, stopDist, STOP_HARD_CAP * atr1h);
              const validStop = ctx.track("S:stop_positive", stopDist > 0, stopDist, 0);

              if (withinCap && validStop) {
                // TP at prior swing low (swing exit)
                const tpPrice = activeSwingLow.price;
                const tpDist = close - tpPrice;
                const rr = tpDist / stopDist;
                const rrOk = ctx.track("S:rr_filter", rr >= MIN_RR, rr, MIN_RR);

                if (rrOk) {
                  const retracePct = ((close - activeSwingLow.price) / activeRange * 100).toFixed(0);
                  resetPullback();
                  return {
                    direction: "short",
                    entryPrice: null,
                    stopLoss: stopPrice,
                    takeProfits: [{ price: tpPrice, pctOfPosition: 1.0 }],
                    comment: `Pullback short: close-beyond at Fib ${retracePct}%`,
                  };
                }
              }
              resetPullback();
              return null;
            }

            pullbackHigh = Math.max(pullbackHigh, currentCandle.h);
            pullbackLow = Math.min(pullbackLow, currentCandle.l);
          }
        }
      }

      // No trend — reset stale pullback
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

      if (direction === "long") {
        const fibDeepPrice = lastSH.price - fibDeep * swingRange;
        const stopPrice = fibDeepPrice - ATR_BUFFER * atr1h;
        return {
          stopLoss: stopPrice,
          takeProfits: [{ price: lastSH.price, pctOfPosition: 1.0 }],
        };
      }
      const fibDeepPrice = lastSL.price + fibDeep * swingRange;
      const stopPrice = fibDeepPrice + ATR_BUFFER * atr1h;
      return {
        stopLoss: stopPrice,
        takeProfits: [{ price: lastSL.price, pctOfPosition: 1.0 }],
      };
    },

    getExitLevel(_ctx: StrategyContext): number | null {
      return null;
    },
  };
}
