import type { Candle } from "../types/candle.js";
import { ema } from "./ema.js";
import { trueRange } from "./true-range.js";

export interface KeltnerResult {
  upper: number[];
  mid: number[];
  lower: number[];
}

/**
 * Keltner Channel — EMA(close) ± multiplier × EMA(TrueRange).
 *
 * Matches Pine's ta.kc which uses EMA of True Range for the band width
 * (not ATR, which uses RMA/Wilder's smoothing).
 */
export function keltner(
  candles: Candle[],
  emaPeriod: number,
  rangePeriod: number,
  multiplier: number,
): KeltnerResult {
  const len = candles.length;
  if (len === 0) return { upper: [], mid: [], lower: [] };

  const closes = candles.map((c) => c.c);
  const midLine = ema(closes, emaPeriod);

  // Pine's ta.kc uses EMA of True Range (not ATR which uses RMA)
  const trValues = candles.map((c, i) =>
    trueRange(c, i > 0 ? candles[i - 1] : null),
  );
  const rangeLine = ema(trValues, rangePeriod);

  const upper = new Array<number>(len).fill(NaN);
  const mid = new Array<number>(len).fill(NaN);
  const lower = new Array<number>(len).fill(NaN);

  for (let i = 0; i < len; i++) {
    if (isNaN(midLine[i]) || isNaN(rangeLine[i])) continue;
    mid[i] = midLine[i];
    upper[i] = midLine[i] + multiplier * rangeLine[i];
    lower[i] = midLine[i] - multiplier * rangeLine[i];
  }

  return { upper, mid, lower };
}
