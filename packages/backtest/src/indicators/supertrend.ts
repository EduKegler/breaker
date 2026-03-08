import type { Candle } from "../types/candle.js";
import { atr } from "./atr.js";

export interface SuperTrendResult {
  supertrend: number[]; // the supertrend line value
  direction: number[]; // 1 = bullish, -1 = bearish
}

/**
 * SuperTrend indicator.
 *
 * 1. Compute ATR(period)
 * 2. Basic upper = HL2 + multiplier * ATR
 * 3. Basic lower = HL2 - multiplier * ATR
 * 4. Final upper = min(basicUpper, prevFinalUpper) if prevClose <= prevFinalUpper, else basicUpper
 * 5. Final lower = max(basicLower, prevFinalLower) if prevClose >= prevFinalLower, else basicLower
 * 6. Direction: 1 = uptrend (bullish), -1 = downtrend (bearish)
 *
 * Returns arrays of the same length as candles.
 * First `period` values are NaN (ATR warmup).
 */
export function supertrend(
  candles: Candle[],
  period = 10,
  multiplier = 3,
): SuperTrendResult {
  const len = candles.length;
  if (len === 0) return { supertrend: [], direction: [] };

  const st = new Array<number>(len).fill(NaN);
  const dir = new Array<number>(len).fill(NaN);

  const atrValues = atr(candles, period);

  const finalUpper = new Array<number>(len).fill(NaN);
  const finalLower = new Array<number>(len).fill(NaN);

  for (let i = 0; i < len; i++) {
    if (isNaN(atrValues[i])) continue;

    const hl2 = (candles[i].h + candles[i].l) / 2;
    const basicUpper = hl2 + multiplier * atrValues[i];
    const basicLower = hl2 - multiplier * atrValues[i];

    // Final upper band
    if (isNaN(finalUpper[i - 1])) {
      finalUpper[i] = basicUpper;
    } else {
      finalUpper[i] =
        basicUpper < finalUpper[i - 1] || candles[i - 1].c > finalUpper[i - 1]
          ? basicUpper
          : finalUpper[i - 1];
    }

    // Final lower band
    if (isNaN(finalLower[i - 1])) {
      finalLower[i] = basicLower;
    } else {
      finalLower[i] =
        basicLower > finalLower[i - 1] || candles[i - 1].c < finalLower[i - 1]
          ? basicLower
          : finalLower[i - 1];
    }

    // Direction and supertrend value
    if (isNaN(dir[i - 1])) {
      // First valid bar: determine initial direction based on close vs bands
      dir[i] = candles[i].c > finalUpper[i] ? 1 : -1;
    } else if (dir[i - 1] === 1) {
      // Was in uptrend
      dir[i] = candles[i].c < finalLower[i] ? -1 : 1;
    } else {
      // Was in downtrend
      dir[i] = candles[i].c > finalUpper[i] ? 1 : -1;
    }

    st[i] = dir[i] === 1 ? finalLower[i] : finalUpper[i];
  }

  return { supertrend: st, direction: dir };
}
