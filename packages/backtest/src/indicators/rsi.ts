import { RSI as RSIIndicator } from "trading-signals";

/**
 * Relative Strength Index (via trading-signals, Wilder's smoothing).
 * Returns array of same length as input. First `period` values are NaN.
 */
export function rsi(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  if (period < 1) throw new Error("RSI period must be >= 1");

  const result = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return result;

  const indicator = new RSIIndicator(period);
  return values.map((v) => {
    indicator.add(v);
    return indicator.isStable ? Number(indicator.getResult()) : NaN;
  });
}
