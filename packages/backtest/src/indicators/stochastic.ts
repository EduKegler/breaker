import type { Candle } from "../types/candle.js";
import { sma } from "./sma.js";

export interface StochasticResult {
  k: number[];
  d: number[];
}

/**
 * Stochastic Oscillator.
 * - %K = (close - lowest(low, period)) / (highest(high, period) - lowest(low, period)) * 100
 * - %D = SMA(%K, smoothPeriod)
 *
 * Returns arrays of the same length as input.
 * First `kPeriod - 1` values of %K are NaN.
 * First `kPeriod - 1 + dPeriod - 1` values of %D are NaN.
 */
export function stochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3,
): StochasticResult {
  const len = candles.length;
  if (len === 0) return { k: [], d: [] };

  const kLine = new Array<number>(len).fill(NaN);

  for (let i = kPeriod - 1; i < len; i++) {
    let highestHigh = -Infinity;
    let lowestLow = Infinity;

    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].h > highestHigh) highestHigh = candles[j].h;
      if (candles[j].l < lowestLow) lowestLow = candles[j].l;
    }

    const range = highestHigh - lowestLow;
    kLine[i] = range === 0 ? 0 : ((candles[i].c - lowestLow) / range) * 100;
  }

  // %D = SMA of %K over the defined portion
  const definedStart = kLine.findIndex((v) => !isNaN(v));
  const dLine = new Array<number>(len).fill(NaN);

  if (definedStart === -1) {
    return { k: kLine, d: dLine };
  }

  const kDefined = kLine.slice(definedStart);
  const dSma = sma(kDefined, dPeriod);

  for (let i = 0; i < kDefined.length; i++) {
    dLine[definedStart + i] = dSma[i];
  }

  return { k: kLine, d: dLine };
}
