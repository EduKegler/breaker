import type { CompletedTrade } from "../types/order.js";
import type { Metrics } from "../types/metrics.js";

/**
 * Compute aggregate Metrics from a list of completed trades.
 * Returns BREAKER-compatible Metrics shape.
 */
export function computeMetrics(
  trades: CompletedTrade[],
  maxDrawdownPct: number,
): Metrics {
  if (trades.length === 0) {
    return {
      totalPnl: 0,
      numTrades: 0,
      profitFactor: null,
      maxDrawdownPct: maxDrawdownPct,
      winRate: null,
      avgR: null,
      avgWinR: null,
      avgLossR: null,
      maxLossR: null,
      expectancy: null,
    };
  }

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = (wins.length / trades.length) * 100;
  const avgR = trades.reduce((sum, t) => sum + t.rMultiple, 0) / trades.length;

  const avgWinR = wins.length > 0
    ? wins.reduce((sum, t) => sum + t.rMultiple, 0) / wins.length
    : null;
  const avgLossR = losses.length > 0
    ? losses.reduce((sum, t) => sum + t.rMultiple, 0) / losses.length
    : null;
  const maxLossR = losses.length > 0
    ? Math.min(...losses.map((t) => t.rMultiple))
    : null;
  const wr = wins.length / trades.length;
  const expectancy = (avgWinR ?? 0) * wr + (avgLossR ?? 0) * (1 - wr);

  return {
    totalPnl,
    numTrades: trades.length,
    profitFactor,
    maxDrawdownPct,
    winRate,
    avgR,
    avgWinR,
    avgLossR,
    maxLossR,
    expectancy,
  };
}
