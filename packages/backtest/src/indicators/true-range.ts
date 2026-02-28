import type { Candle } from "../types/candle.js";

/**
 * True Range for a single bar.
 */
export function trueRange(current: Candle, previous: Candle | null): number {
  if (!previous) return current.h - current.l;
  return Math.max(
    current.h - current.l,
    Math.abs(current.h - previous.c),
    Math.abs(current.l - previous.c),
  );
}
