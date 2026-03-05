import type { WalkForward } from "@breaker/backtest";
import type { LoopConfig } from "./types.js";

/**
 * Check if backtest metrics meet all configured criteria.
 *
 * KB §10.1: pfRatio >= 0.6 is part of stopping criteria for all modules.
 * The backtest engine sets overfitFlag=true when pfRatio < 0.6, so checking
 * overfitFlag is equivalent to enforcing the pfRatio floor.
 */
export function checkCriteria(
  metrics: { totalPnl: number | null; numTrades: number | null; profitFactor: number | null; maxDrawdownPct: number | null; winRate: number | null; avgR: number | null },
  criteria: LoopConfig["criteria"],
  walkForward?: WalkForward | null,
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
  const minWR = criteria.minWR ?? 0;
  const minAvgR = criteria.minAvgR ?? 0.15;

  // Walk-forward overfit gate (KB §10.1): overfitFlag=true means pfRatio < 0.6
  if (walkForward?.overfitFlag) return false;

  return (
    pnl > 0 &&
    trades >= minTrades &&
    pf >= minPF &&
    dd <= maxDD &&
    wr >= minWR &&
    avgR >= minAvgR
  );
}
