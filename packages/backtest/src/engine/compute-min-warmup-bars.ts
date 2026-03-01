import type { Strategy } from "../types/strategy.js";
import { intervalToMs, type CandleInterval } from "../types/candle.js";

const MARGIN = 0.2; // 20% extra for bucket alignment in aggregation

/**
 * Computes the minimum number of source-interval bars needed to satisfy
 * a strategy's `requiredWarmup` declaration.
 *
 * For each HTF entry, converts the required HTF candles to source bars
 * using `ceil(htfMs / sourceMs)` and adds a 20% margin for bucket alignment.
 * Returns the max across all timeframes (including "source").
 */
export function computeMinWarmupBars(
  strategy: Strategy,
  sourceInterval: CandleInterval,
): number {
  const req = strategy.requiredWarmup;
  if (!req || Object.keys(req).length === 0) return 0;

  const sourceMs = intervalToMs(sourceInterval);
  let maxBars = 0;

  for (const [tf, minCandles] of Object.entries(req)) {
    if (tf === "source") {
      // Source requirement — no conversion, no margin
      maxBars = Math.max(maxBars, minCandles);
      continue;
    }

    const htfMs = intervalToMs(tf as CandleInterval);
    const ratio = Math.ceil(htfMs / sourceMs);
    const rawBars = minCandles * ratio;
    const withMargin = Math.ceil(rawBars * (1 + MARGIN));
    maxBars = Math.max(maxBars, withMargin);
  }

  return maxBars;
}
