import type { Candle } from "../types/candle.js";

export interface VwapResult {
  vwap: number[];
  upper: number[];
  lower: number[];
}

/**
 * Session VWAP (Volume Weighted Average Price) with standard deviation bands.
 *
 * - vwap = cumulative(typicalPrice * volume) / cumulative(volume)
 * - typical price = (high + low + close) / 3
 * - upper = vwap + bandMultiplier * stddev
 * - lower = vwap - bandMultiplier * stddev
 *
 * Cumulative from start of data (no session reset, suitable for backtesting).
 * First candle is always valid (no NaN warmup).
 * Zero volume bars carry forward the last VWAP value.
 */
export function vwap(candles: Candle[], bandMultiplier = 2): VwapResult {
  const len = candles.length;
  if (len === 0) return { vwap: [], upper: [], lower: [] };

  const vwapArr = new Array<number>(len);
  const upperArr = new Array<number>(len);
  const lowerArr = new Array<number>(len);

  let cumTPV = 0; // cumulative(typicalPrice * volume)
  let cumV = 0;   // cumulative(volume)
  let cumTPV2 = 0; // cumulative(typicalPrice^2 * volume) for variance
  let lastVwap = NaN;

  for (let i = 0; i < len; i++) {
    const c = candles[i];
    const tp = (c.h + c.l + c.c) / 3;

    if (c.v === 0) {
      // Zero volume: carry forward previous VWAP (or use tp for first candle)
      if (isNaN(lastVwap)) {
        lastVwap = tp;
      }
      vwapArr[i] = lastVwap;
      // With zero volume added, stddev remains unchanged; use 0 deviation
      // since we can't compute meaningful variance contribution
      upperArr[i] = lastVwap;
      lowerArr[i] = lastVwap;
      continue;
    }

    cumTPV += tp * c.v;
    cumV += c.v;
    cumTPV2 += tp * tp * c.v;

    const currentVwap = cumTPV / cumV;
    vwapArr[i] = currentVwap;
    lastVwap = currentVwap;

    // Volume-weighted variance: E[X^2] - E[X]^2
    const variance = cumTPV2 / cumV - currentVwap * currentVwap;
    // Guard against floating-point rounding producing tiny negative variance
    const stddev = Math.sqrt(Math.max(0, variance));

    upperArr[i] = currentVwap + bandMultiplier * stddev;
    lowerArr[i] = currentVwap - bandMultiplier * stddev;
  }

  return { vwap: vwapArr, upper: upperArr, lower: lowerArr };
}
