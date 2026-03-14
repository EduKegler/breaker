import type { WalkForward, RollingWalkForward } from "@breaker/backtest";
import type { LoopConfig } from "./types.js";

type MetricsInput = { totalPnl: number | null; numTrades: number | null; profitFactor: number | null; maxDrawdownPct: number | null; winRate: number | null; avgR: number | null };

/**
 * Check if backtest metrics meet all configured criteria.
 *
 * KB §10.1: pfRatio >= 0.6 is part of stopping criteria for all modules.
 * The backtest engine sets overfitFlag=true when pfRatio < 0.6, so checking
 * overfitFlag is equivalent to enforcing the pfRatio floor.
 */
export function checkCriteria(
  metrics: MetricsInput,
  criteria: LoopConfig["criteria"],
  walkForward?: WalkForward | null,
  rollingWalkForward?: RollingWalkForward | null,
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

  // Rolling walk-forward overfit gate: majority of windows failed
  if (rollingWalkForward?.overfitFlag) return false;

  return (
    pnl > 0 &&
    trades >= minTrades &&
    pf >= minPF &&
    Math.abs(dd) <= maxDD &&
    wr >= minWR &&
    avgR >= minAvgR
  );
}

/**
 * Check if backtest metrics meet stretch criteria (degradation-adjusted).
 * Same as checkCriteria but uses stretchPF/stretchAvgR instead of config minimums.
 */
export function checkStretchCriteria(
  metrics: MetricsInput,
  criteria: LoopConfig["criteria"],
  stretchPF: number,
  stretchAvgR: number | null,
  walkForward?: WalkForward | null,
  rollingWalkForward?: RollingWalkForward | null,
): boolean {
  if (walkForward?.overfitFlag) return false;
  if (rollingWalkForward?.overfitFlag) return false;

  const pnl = metrics.totalPnl ?? 0;
  const trades = metrics.numTrades ?? 0;
  const pf = metrics.profitFactor ?? 0;
  const dd = metrics.maxDrawdownPct ?? 100;
  const wr = metrics.winRate ?? 0;
  const avgR = metrics.avgR ?? 0;

  const minTrades = criteria.minTrades ?? 150;
  const maxDD = criteria.maxDD ?? 12;
  const minWR = criteria.minWR ?? 0;

  return (
    pnl > 0 &&
    trades >= minTrades &&
    pf >= stretchPF &&
    Math.abs(dd) <= maxDD &&
    wr >= minWR &&
    (stretchAvgR === null || avgR >= stretchAvgR)
  );
}
