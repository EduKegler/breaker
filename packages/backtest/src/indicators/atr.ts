import { ATR as ATRIndicator } from "trading-signals";
import type { Candle } from "../types/candle.js";

/**
 * Average True Range (via trading-signals, Wilder's smoothing).
 * Returns an array of the same length as candles.
 * First `period` values are NaN (need period bars for first ATR).
 */
export function atr(candles: Candle[], period: number): number[] {
  if (candles.length === 0) return [];
  if (period < 1) throw new Error("ATR period must be >= 1");

  const result = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return result;

  const indicator = new ATRIndicator(period);
  return candles.map((c) => {
    indicator.add({ high: c.h, low: c.l, close: c.c });
    return indicator.isStable ? Number(indicator.getResult()) : NaN;
  });
}
