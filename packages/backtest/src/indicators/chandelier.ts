import type { Candle } from "../types/candle.js";
import { atr } from "./atr.js";

export interface ChandelierResult {
  longExit: number[]; // exit level for long positions
  shortExit: number[]; // exit level for short positions
}

/**
 * Chandelier Exit indicator.
 *
 * - Long exit  = highest high over period − multiplier × ATR(period)
 * - Short exit = lowest low over period  + multiplier × ATR(period)
 *
 * Returns arrays of the same length as candles.
 * NaN for the warmup period (determined by max of ATR warmup and lookback window).
 */
export function chandelier(
  candles: Candle[],
  period = 22,
  multiplier = 3,
): ChandelierResult {
  const len = candles.length;
  if (len === 0) return { longExit: [], shortExit: [] };

  const longExit = new Array<number>(len).fill(NaN);
  const shortExit = new Array<number>(len).fill(NaN);

  const atrValues = atr(candles, period);

  for (let i = 0; i < len; i++) {
    if (isNaN(atrValues[i])) continue;

    // Sliding window for highest high and lowest low over `period` bars
    // Window: [i - period + 1, i]
    const start = Math.max(0, i - period + 1);
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let j = start; j <= i; j++) {
      if (candles[j].h > highestHigh) highestHigh = candles[j].h;
      if (candles[j].l < lowestLow) lowestLow = candles[j].l;
    }

    longExit[i] = highestHigh - multiplier * atrValues[i];
    shortExit[i] = lowestLow + multiplier * atrValues[i];
  }

  return { longExit, shortExit };
}
