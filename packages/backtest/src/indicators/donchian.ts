import type { Candle } from "../types/candle.js";

export interface DonchianResult {
  upper: number[];
  lower: number[];
  mid: number[];
}

/**
 * Donchian Channel — highest high and lowest low over `period` bars.
 * Returns arrays of the same length as candles.
 * First `period - 1` values are NaN.
 */
export function donchian(candles: Candle[], period: number): DonchianResult {
  const len = candles.length;
  if (len === 0) return { upper: [], lower: [], mid: [] };
  if (period < 1) throw new Error("Donchian period must be >= 1");

  const upper = new Array<number>(len).fill(NaN);
  const lower = new Array<number>(len).fill(NaN);
  const mid = new Array<number>(len).fill(NaN);

  for (let i = period - 1; i < len; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let hasValidHi = false;
    let hasValidLo = false;
    for (let j = i - period + 1; j <= i; j++) {
      const h = candles[j].h;
      const l = candles[j].l;
      if (!isNaN(h) && h > hi) { hi = h; hasValidHi = true; }
      if (!isNaN(l) && l < lo) { lo = l; hasValidLo = true; }
    }
    upper[i] = hasValidHi ? hi : NaN;
    lower[i] = hasValidLo ? lo : NaN;
    mid[i] = hasValidHi && hasValidLo ? (hi + lo) / 2 : NaN;
  }

  return { upper, lower, mid };
}
