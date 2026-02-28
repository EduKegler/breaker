import type { Candle, CandleInterval } from "../types/candle.js";
import { intervalToMs } from "../types/candle.js";

/**
 * Aggregate lower-timeframe candles into higher-timeframe candles.
 */
export function aggregateCandles(
  candles: Candle[],
  sourceInterval: CandleInterval,
  targetInterval: CandleInterval,
): Candle[] {
  const sourceMs = intervalToMs(sourceInterval);
  const targetMs = intervalToMs(targetInterval);

  if (targetMs <= sourceMs) return candles;

  const result: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketStart = 0;

  for (const c of candles) {
    const alignedTs = Math.floor(c.t / targetMs) * targetMs;

    if (bucket === null || alignedTs !== bucketStart) {
      if (bucket) result.push(bucket);
      bucketStart = alignedTs;
      bucket = { t: alignedTs, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: c.n };
    } else {
      bucket.h = Math.max(bucket.h, c.h);
      bucket.l = Math.min(bucket.l, c.l);
      bucket.c = c.c;
      bucket.v += c.v;
      bucket.n += c.n;
    }
  }

  if (bucket) result.push(bucket);
  return result;
}
