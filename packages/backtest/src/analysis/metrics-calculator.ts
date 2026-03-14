import type { CompletedTrade } from "../types/order.js";
import type { Metrics } from "../types/metrics.js";

/**
 * Compute aggregate Metrics from a list of completed trades.
 * Returns BREAKER-compatible Metrics shape.
 *
 * @param tradingDays - Number of calendar days in backtest window (for tradesPerDay). 0 = unknown.
 * @param initialCapital - Starting capital (for totalCostPct). 0 = unknown.
 */
export function computeMetrics(
  trades: CompletedTrade[],
  maxDrawdownPct: number,
  tradingDays: number = 0,
  initialCapital: number = 0,
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
      edgeBpsGross: null,
      edgeBpsNet: null,
      avgCostBps: null,
      tradesPerDay: null,
      totalCostPct: null,
      sharpeRatio: null,
      sortinoRatio: null,
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

  // Cost-aware metrics (notional-weighted)
  // weighted = sum(pnl) / sum(notional) * 10_000
  // This ensures edgeBpsNet sign always matches totalPnl sign,
  // even when trade sizes vary (risk-based sizing).
  let sumCosts = 0;
  let sumNotional = 0;

  for (const t of trades) {
    const notional = t.entryPrice * t.size;
    sumNotional += notional;
    sumCosts += t.commission + t.slippageCost + (t.fundingCost ?? 0);
  }

  const edgeBpsGross = sumNotional > 0 ? ((totalPnl + sumCosts) / sumNotional) * 10_000 : 0;
  const edgeBpsNet = sumNotional > 0 ? (totalPnl / sumNotional) * 10_000 : 0;
  const avgCostBps = sumNotional > 0 ? (sumCosts / sumNotional) * 10_000 : 0;
  const tradesPerDay = tradingDays > 0 ? trades.length / tradingDays : null;
  const totalCostPct = initialCapital > 0 ? (sumCosts / initialCapital) * 100 : null;

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
    edgeBpsGross,
    edgeBpsNet,
    avgCostBps,
    tradesPerDay,
    totalCostPct,
    sharpeRatio: null,
    sortinoRatio: null,
  };
}
