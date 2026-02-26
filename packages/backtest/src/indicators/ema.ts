import { EMA as EMAIndicator } from "trading-signals";

/**
 * Exponential Moving Average (via trading-signals).
 * Returns an array of the same length as input.
 * First `period - 1` values are NaN (indicator not yet stable).
 */
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  if (period < 1) throw new Error("EMA period must be >= 1");
  if (period > values.length) {
    return new Array(values.length).fill(NaN);
  }

  const indicator = new EMAIndicator(period);
  return values.map((v) => {
    indicator.add(v);
    return indicator.isStable ? Number(indicator.getResult()) : NaN;
  });
}
