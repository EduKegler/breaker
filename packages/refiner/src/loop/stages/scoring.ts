import type { Metrics } from "@breaker/backtest";
import type { ScoringWeights } from "../../types/config.js";

export interface ScoreRaw {
  pf: number;
  avgR: number;
  wr: number;
  dd: number;
  complexity: number;
  sampleConfidence: number;
}

interface MultiObjectiveScore {
  raw: ScoreRaw;
  weighted: number; // 0-100
  breakdown: string;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  pf: 30,
  avgR: 25,
  wr: 12,
  dd: 18,
  complexity: 15,
  sampleConfidence: 0, // gate only — no weight reward for trade count
};

/**
 * Compute multi-objective score for a strategy iteration.
 * Returns a weighted score 0-100 where higher is better.
 *
 * @param metrics - Backtest metrics
 * @param paramCount - Number of optimizable parameters (replaces Pine filter counting)
 * @param tradeCount - Number of trades
 * @param weights - Optional scoring weight overrides
 */
export function computeScore(
  metrics: Metrics,
  paramCount: number,
  tradeCount: number,
  weights?: Partial<ScoringWeights>,
): MultiObjectiveScore {
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  const pf = metrics.profitFactor ?? 0;
  const avgR = metrics.avgR ?? 0;
  const wr = metrics.winRate ?? 0;
  const rawDd = metrics.maxDrawdownPct ?? 100;
  const dd = Number.isFinite(rawDd) ? rawDd : 100;

  // Component scores (clamped to 0-1 range before weighting)
  const pfScore = Math.max(0, Math.min(pf / 2.0, 1.0));
  const avgRScore = Math.max(0, Math.min(avgR / 0.5, 1.0));
  const wrScore = Math.max(0, Math.min(wr / 60, 1.0));
  const ddScore = Math.max(0, Math.min(1, 1 - Math.abs(dd) / 15));
  // Complexity: fewer params = better. Baseline of 3, zero at 10 (KB cap is 6-8).
  const complexityScore = Math.min(1, Math.max(0, 1 - (paramCount - 3) / 7));
  const sampleScore = Math.min(tradeCount / 150, 1.0);

  const raw = {
    pf: pfScore,
    avgR: avgRScore,
    wr: wrScore,
    dd: ddScore,
    complexity: complexityScore,
    sampleConfidence: sampleScore,
  };

  // Below sampleFloor trades, apply a multiplicative penalty to the entire score.
  // This prevents statistically meaningless results (e.g. 2 perfect trades) from
  // getting inflated scores that mislead the optimizer.
  const sampleFloor = 20;
  const sampleMultiplier = tradeCount >= sampleFloor ? 1.0 : tradeCount / sampleFloor;

  const weighted =
    (pfScore * w.pf +
    avgRScore * w.avgR +
    wrScore * w.wr +
    ddScore * w.dd +
    complexityScore * w.complexity +
    sampleScore * w.sampleConfidence) * sampleMultiplier;

  const costAwareParts = [
    metrics.tradesPerDay != null ? `T/day: ${metrics.tradesPerDay.toFixed(2)}` : null,
    metrics.edgeBpsNet != null ? `Edge(net): ${metrics.edgeBpsNet.toFixed(0)} bps` : null,
  ].filter(Boolean);

  const breakdown = [
    `PF: ${(pfScore * w.pf).toFixed(1)}/${w.pf}`,
    `avgR: ${(avgRScore * w.avgR).toFixed(1)}/${w.avgR}`,
    `WR: ${(wrScore * w.wr).toFixed(1)}/${w.wr}`,
    `DD: ${(ddScore * w.dd).toFixed(1)}/${w.dd}`,
    `Complex: ${(complexityScore * w.complexity).toFixed(1)}/${w.complexity}`,
    `Sample: ${(sampleScore * w.sampleConfidence).toFixed(1)}/${w.sampleConfidence}`,
    ...costAwareParts,
  ].join(" | ");

  return { raw, weighted: Math.round(weighted * 100) / 100, breakdown };
}

export type ScoreVerdict = "accept" | "reject" | "neutral";
