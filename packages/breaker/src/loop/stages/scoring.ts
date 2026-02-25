import type { Metrics } from "../../types/parse-results.js";
import type { ScoringWeights } from "../../types/config.js";

export interface MultiObjectiveScore {
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
 * Count total active filters from pine content.
 * Counts boolean filter toggles (useXxx = true), blocked hours, and blocked days.
 */
export function countFilters(pineContent: string): number {
  // Ignore commented lines to avoid inflating complexity with historical notes.
  const activeContent = pineContent
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  let count = 0;

  // Count boolean filter toggles that are ON
  const boolFilters = activeContent.matchAll(/\b(use\w+)\s*=\s*true\b/gi);
  for (const _ of boolFilters) count++;

  // Count blocked hours (both "utcHour == N" and "badHour == N" patterns)
  const hourMatches = activeContent.matchAll(/(?:utcHour|badHour)\s*==\s*\d+/g);
  for (const _ of hourMatches) count++;

  // Count blocked days (e.g., badDay == dayofweek.monday)
  const dayMatches = activeContent.matchAll(/\b\w+\s*==\s*dayofweek\.\w+\b/gi);
  for (const _ of dayMatches) count++;

  return count;
}

/**
 * Compute multi-objective score for a strategy iteration.
 * Returns a weighted score 0-100 where higher is better.
 */
export function computeScore(
  metrics: Metrics,
  pineContent: string,
  tradeCount: number,
  weights?: Partial<ScoringWeights>,
): MultiObjectiveScore {
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  const pf = metrics.profitFactor ?? 0;
  const avgR = metrics.avgR ?? 0;
  const wr = metrics.winRate ?? 0;
  const dd = metrics.maxDrawdownPct ?? 100;
  const filters = countFilters(pineContent);

  // Component scores (0-1 range before weighting)
  const pfScore = Math.min(pf / 2.0, 1.0);
  const avgRScore = Math.min(avgR / 0.5, 1.0);
  const wrScore = Math.min(wr / 40, 1.0);
  const ddScore = Math.max(0, 1 - dd / 15);
  const complexityScore = Math.min(1, Math.max(0, 1 - (filters - 5) / 15));
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
