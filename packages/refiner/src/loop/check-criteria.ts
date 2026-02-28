import type { LoopConfig } from "./types.js";

/**
 * Check if backtest metrics meet all configured criteria.
 */
export function checkCriteria(
  metrics: { totalPnl: number | null; numTrades: number | null; profitFactor: number | null; maxDrawdownPct: number | null; winRate: number | null; avgR: number | null },
  criteria: LoopConfig["criteria"],
): boolean {
  const pnl = metrics.totalPnl ?? 0;
  const trades = metrics.numTrades ?? 0;
  const pf = metrics.profitFactor ?? 0;
  const dd = metrics.maxDrawdownPct ?? 100;
  const wr = metrics.winRate ?? 0;
  const avgR = metrics.avgR ?? 0;

  const minTrades = criteria.minTrades ?? 150;
  const minPF = criteria.minPF ?? 1.25;
  const maxDD = criteria.maxDD ?? 12;
  const minWR = criteria.minWR ?? 20;
  const minAvgR = criteria.minAvgR ?? 0.15;

  return (
    pnl > 0 &&
    trades >= minTrades &&
    pf >= minPF &&
    dd <= maxDD &&
    wr >= minWR &&
    avgR >= minAvgR
  );
}
