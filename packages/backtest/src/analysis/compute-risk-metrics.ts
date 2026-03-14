import type { EquityPoint } from "../engine/equity-curve.js";

export interface RiskMetrics {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
}

const ANNUALIZATION_FACTOR = Math.sqrt(252);

/**
 * Compute Sharpe and Sortino ratios from equity curve points.
 *
 * Groups equity points by calendar day (UTC), takes the last equity
 * value per day, then computes daily returns.
 *
 * Sharpe  = mean(dailyReturns) / std(dailyReturns) × √252
 * Sortino = mean(dailyReturns) / downside_std(dailyReturns) × √252
 */
export function computeRiskMetrics(equityPoints: EquityPoint[]): RiskMetrics {
  const nullResult: RiskMetrics = { sharpeRatio: null, sortinoRatio: null };

  if (equityPoints.length === 0) return nullResult;

  // Group by calendar day (UTC), keep last equity per day
  const dailyEquity = new Map<string, number>();
  for (const point of equityPoints) {
    const day = new Date(point.timestamp).toISOString().slice(0, 10);
    dailyEquity.set(day, point.equity);
  }

  const equities = [...dailyEquity.values()];
  if (equities.length < 2) return nullResult;

  // Compute daily returns
  const returns: number[] = [];
  for (let i = 1; i < equities.length; i++) {
    if (equities[i - 1] === 0) continue;
    returns.push((equities[i] - equities[i - 1]) / equities[i - 1]);
  }

  if (returns.length < 2) return nullResult;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Standard deviation
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);

  if (std === 0) return nullResult;

  const sharpeRatio = (mean / std) * ANNUALIZATION_FACTOR;

  // Downside deviation (only negative returns)
  const downsideVariance = returns.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) / returns.length;
  const downsideStd = Math.sqrt(downsideVariance);

  const sortinoRatio = downsideStd > 0
    ? (mean / downsideStd) * ANNUALIZATION_FACTOR
    : null;

  return { sharpeRatio, sortinoRatio };
}
