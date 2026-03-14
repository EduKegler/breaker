import type { Candle } from "../types/candle.js";
import type { CompletedTrade } from "../types/order.js";
import type { RegimeName, RegimeStats } from "../types/metrics.js";

type RegimeStatsResult = Partial<Record<RegimeName, RegimeStats>>;
import { adx } from "../indicators/adx.js";

export const REGIME_ADX_PERIOD = 14;
const LOOKBACK_BARS = 20;
const ADX_TRENDING_THRESHOLD = 25;
const ADX_RANGING_THRESHOLD = 20;

/**
 * Classify market regime for each trade using a lookback window before entry.
 * ADX(14) > 25 = trending, < 20 = ranging, 20-25 = unclear.
 * Requires candles array that matches the entryBarIndex values in trades.
 */
export function computeRegimeStats(
  trades: CompletedTrade[],
  candles: Candle[],
  precomputedAdx?: number[],
): RegimeStatsResult | null {
  if (trades.length === 0 || candles.length === 0) return null;

  const buckets: Record<string, { count: number; pnl: number; wins: number; grossWin: number; grossLoss: number }> = {};

  // Use pre-computed ADX if provided, otherwise compute O(n) once
  const adxResult = precomputedAdx
    ? { adx: precomputedAdx }
    : adx(candles, REGIME_ADX_PERIOD);

  for (const t of trades) {
    const regime = classifyRegime(t.entryBarIndex, adxResult.adx);

    if (!buckets[regime]) {
      buckets[regime] = { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 };
    }
    const b = buckets[regime];
    b.count++;
    b.pnl += t.pnl;
    if (t.pnl > 0) {
      b.wins++;
      b.grossWin += t.pnl;
    } else {
      b.grossLoss += Math.abs(t.pnl);
    }
  }

  const result: RegimeStatsResult = {};
  for (const [regime, b] of Object.entries(buckets)) {
    result[regime as RegimeName] = {
      count: b.count,
      pnl: b.pnl,
      winRate: b.count > 0 ? (b.wins / b.count) * 100 : 0,
      profitFactor: b.grossLoss > 0 ? b.grossWin / b.grossLoss : b.grossWin > 0 ? Infinity : 0,
      avgTrade: b.count > 0 ? b.pnl / b.count : 0,
    };
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Classify regime at a given bar index using mean ADX over a lookback window.
 * Uses pre-computed indicator arrays for O(1) per trade.
 */
export function classifyRegime(
  entryBarIndex: number,
  adxValues: number[],
): RegimeName {
  const start = Math.max(0, entryBarIndex - LOOKBACK_BARS);
  const end = entryBarIndex;

  if (start >= end) return "unclear";

  let adxSum = 0;
  let adxCount = 0;
  for (let i = start; i < end; i++) {
    if (!isNaN(adxValues[i])) {
      adxSum += adxValues[i];
      adxCount++;
    }
  }

  if (adxCount === 0) return "unclear";

  const meanAdx = adxSum / adxCount;

  if (meanAdx > ADX_TRENDING_THRESHOLD) return "trending";
  if (meanAdx < ADX_RANGING_THRESHOLD) return "ranging";
  return "unclear";
}
