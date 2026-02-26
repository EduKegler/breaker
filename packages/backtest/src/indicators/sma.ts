import { SMA as SMAIndicator } from "trading-signals";

/**
 * Simple Moving Average (via trading-signals).
 * Returns an array of the same length as input.
 * First `period - 1` values are NaN.
 */
export function sma(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  if (period < 1) throw new Error("SMA period must be >= 1");
  if (period > values.length) {
    return new Array(values.length).fill(NaN);
  }

  const indicator = new SMAIndicator(period);
  return values.map((v) => {
    indicator.add(v);
    return indicator.isStable ? Number(indicator.getResult()) : NaN;
  });
}
