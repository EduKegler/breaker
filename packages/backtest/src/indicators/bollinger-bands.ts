import { BollingerBands as BBIndicator } from "trading-signals";

export interface BollingerBandsResult {
  upper: number[];
  mid: number[];
  lower: number[];
}

/**
 * Bollinger Bands (via trading-signals).
 * Returns arrays of the same length as input.
 * First `period` values are NaN (stable at period + 1).
 */
export function bollingerBands(
  values: number[],
  period: number,
  multiplier = 2.0,
): BollingerBandsResult {
  if (values.length === 0) return { upper: [], mid: [], lower: [] };
  if (period < 1) throw new Error("BB period must be >= 1");

  const indicator = new BBIndicator(period, multiplier);
  const upper: number[] = [];
  const mid: number[] = [];
  const lower: number[] = [];

  for (const v of values) {
    indicator.add(v);
    if (indicator.isStable) {
      const result = indicator.getResult()!;
      upper.push(Number(result.upper));
      mid.push(Number(result.middle));
      lower.push(Number(result.lower));
    } else {
      upper.push(NaN);
      mid.push(NaN);
      lower.push(NaN);
    }
  }

  return { upper, mid, lower };
}
