import type { Metrics } from "@breaker/backtest";
import type { ScoringWeights } from "../../types/config.js";

interface MultiObjectiveScore {
  raw: {
    pf: number;
    avgR: number;
    wr: number;
    dd: number;
    complexity: number;
    sampleConfidence: number;
  };
  weighted: number; // 0-100
  breakdown: string;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  pf: 25,
  avgR: 20,
  wr: 10,
  dd: 15,
  complexity: 10,
  sampleConfidence: 20,
};

/**
 * Compute complexity from optimizable parameter count.
 * Fewer params = less overfitting risk = higher score.
 */
export function countParams(paramCount: number): number {
  return paramCount;
}

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
  const dd = metrics.maxDrawdownPct ?? 100;

  // Component scores (0-1 range before weighting)
  const pfScore = Math.min(pf / 2.0, 1.0);
  const avgRScore = Math.min(avgR / 0.5, 1.0);
  const wrScore = Math.min(wr / 40, 1.0);
  const ddScore = Math.max(0, 1 - dd / 15);
  // Complexity: fewer params = better. Baseline of 5, penalize above.
  const complexityScore = Math.min(1, Math.max(0, 1 - (paramCount - 5) / 15));
  const sampleScore = Math.min(tradeCount / 150, 1.0);

  const raw = {
    pf: pfScore,
    avgR: avgRScore,
    wr: wrScore,
    dd: ddScore,
    complexity: complexityScore,
    sampleConfidence: sampleScore,
  };

  const weighted =
    pfScore * w.pf +
    avgRScore * w.avgR +
    wrScore * w.wr +
    ddScore * w.dd +
    complexityScore * w.complexity +
    sampleScore * w.sampleConfidence;

  const breakdown = [
    `PF: ${(pfScore * w.pf).toFixed(1)}/${w.pf}`,
    `avgR: ${(avgRScore * w.avgR).toFixed(1)}/${w.avgR}`,
    `WR: ${(wrScore * w.wr).toFixed(1)}/${w.wr}`,
    `DD: ${(ddScore * w.dd).toFixed(1)}/${w.dd}`,
    `Complex: ${(complexityScore * w.complexity).toFixed(1)}/${w.complexity}`,
    `Sample: ${(sampleScore * w.sampleConfidence).toFixed(1)}/${w.sampleConfidence}`,
  ].join(" | ");

  return { raw, weighted: Math.round(weighted * 100) / 100, breakdown };
}

export type ScoreVerdict = "accept" | "reject" | "neutral";

/**
 * Compare new score vs old score and return verdict.
 * accept: score_new > score_old * 1.02
 * reject: score_new < score_old * 0.85
 * neutral: in between
 */
export function compareScores(scoreNew: number, scoreOld: number): ScoreVerdict {
  if (scoreOld <= 0) return scoreNew > 0 ? "accept" : "neutral";
  if (scoreNew > scoreOld * 1.02) return "accept";
  if (scoreNew < scoreOld * 0.85) return "reject";
  return "neutral";
}
