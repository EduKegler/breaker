import type { ScoreVerdict } from "./scoring.js";

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
