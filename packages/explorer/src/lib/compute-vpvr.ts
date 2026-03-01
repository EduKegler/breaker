export interface VpvrBucket {
  priceFrom: number;
  priceTo: number;
  volume: number;
  isPoc: boolean;
}

export interface VpvrInput {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Compute Volume Profile Visible Range (VPVR) from candle data.
 * Distributes each candle's volume proportionally across the price buckets it spans.
 *
 * @param candles - Candle data with OHLCV
 * @param bucketCount - Number of price buckets (default 40)
 * @returns Array of buckets with volume and POC flag
 */
export function computeVpvr(candles: VpvrInput[], bucketCount = 40): VpvrBucket[] {
  if (candles.length === 0) return [];

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const c of candles) {
    if (c.low < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
  }

  if (minPrice === maxPrice || !isFinite(minPrice) || !isFinite(maxPrice)) {
    return [{
      priceFrom: minPrice,
      priceTo: maxPrice,
      volume: candles.reduce((sum, c) => sum + c.volume, 0),
      isPoc: true,
    }];
  }

  const range = maxPrice - minPrice;
  const bucketSize = range / bucketCount;
  const buckets = new Float64Array(bucketCount);

  for (const c of candles) {
    if (c.volume <= 0 || c.high <= c.low) continue;
    const candleRange = c.high - c.low;

    // Determine which buckets this candle spans
    const startBucket = Math.max(0, Math.floor((c.low - minPrice) / bucketSize));
    const endBucket = Math.min(bucketCount - 1, Math.floor((c.high - minPrice) / bucketSize));

    if (startBucket === endBucket) {
      buckets[startBucket] += c.volume;
    } else {
      // Distribute proportionally
      for (let i = startBucket; i <= endBucket; i++) {
        const bucketLow = minPrice + i * bucketSize;
        const bucketHigh = bucketLow + bucketSize;
        const overlapLow = Math.max(c.low, bucketLow);
        const overlapHigh = Math.min(c.high, bucketHigh);
        const overlap = Math.max(0, overlapHigh - overlapLow);
        buckets[i] += c.volume * (overlap / candleRange);
      }
    }
  }

  // Find POC (Point of Control) — bucket with max volume
  let pocIdx = 0;
  let maxVol = 0;
  for (let i = 0; i < bucketCount; i++) {
    if (buckets[i] > maxVol) {
      maxVol = buckets[i];
      pocIdx = i;
    }
  }

  const result: VpvrBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    result.push({
      priceFrom: minPrice + i * bucketSize,
      priceTo: minPrice + (i + 1) * bucketSize,
      volume: buckets[i],
      isPoc: i === pocIdx,
    });
  }

  return result;
}
