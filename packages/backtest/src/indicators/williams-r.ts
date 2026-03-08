import type { Candle } from "../types/candle.js";

/**
 * Williams %R — momentum oscillator measuring close relative to
 * the highest high / lowest low over `period` bars.
 *
 * Formula: %R = (highestHigh - close) / (highestHigh - lowestLow) * -100
 *
 * Range: -100 to 0 (oversold below -80, overbought above -20).
 * First `period - 1` values are NaN (warmup).
 * Returns NaN when highestHigh === lowestLow (zero range).
 */
export function williamsR(candles: Candle[], period = 14): number[] {
  const len = candles.length;
  if (len === 0) return [];

  const result = new Array<number>(len).fill(NaN);

  for (let i = period - 1; i < len; i++) {
    let highestHigh = -Infinity;
    let lowestLow = Infinity;

    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].h > highestHigh) highestHigh = candles[j].h;
      if (candles[j].l < lowestLow) lowestLow = candles[j].l;
    }

    const range = highestHigh - lowestLow;
    if (range === 0) {
      result[i] = NaN;
    } else {
      result[i] = ((highestHigh - candles[i].c) / range) * -100;
    }
  }

  return result;
}
