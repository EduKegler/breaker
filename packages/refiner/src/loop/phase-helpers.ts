import type { ScoreVerdict } from "./stages/scoring.js";
import type { IterationState, LoopConfig, LoopPhase } from "./types.js";
import { MODULE_CRITERIA } from "../lib/build-module-context.js";

/**
 * Helpers for phase management in the optimization loop.
 * Provides escalation logic, counter resets, max-iter computation,
 * phase transitions, and verdict adjustment.
 */
export const phaseHelpers = {
  /**
   * Determine if we should escalate from current phase.
   * refine -> research: 3+ consecutive neutral or 2+ no-change
   * research -> restructure: 2+ no-change
   * restructure -> refine (next cycle): 2+ no-change
   */
  shouldEscalate(state: IterationState, _cfg: LoopConfig): boolean {
    if (state.currentPhase === "refine") {
      return state.neutralStreak >= 3 || state.noChangeCount >= 2;
    }
    if (state.currentPhase === "research" || state.currentPhase === "restructure") {
      return state.noChangeCount >= 2;
    }
    return false;
  },

  /**
   * Reset counters that should not carry over between phases.
   */
  resetCounters(state: IterationState): void {
    state.fixAttempts = 0;
    state.transientFailures = 0;
    state.neutralStreak = 0;
    state.noChangeCount = 0;
  },

  /**
   * Compute effective maxIter for a phase.
   * Uses the larger of: config value OR proportional allocation of global maxIter.
   * Proportions: refine 40%, research 20%, restructure 40%.
   */
  getMaxIter(phase: LoopPhase, cfg: LoopConfig): number {
    const proportions: Record<LoopPhase, number> = { refine: 0.4, research: 0.2, restructure: 0.4 };
    const proportional = Math.max(1, Math.round(cfg.maxIter * proportions[phase]));
    return Math.max(cfg.phases[phase].maxIter, proportional);
  },

  /**
   * Determine next phase when phaseIterCount exceeds the phase's maxIter.
   */
  transitionOnMaxIter(
    currentPhase: LoopPhase,
    phaseCycles: number,
    maxCycles: number,
  ): { nextPhase: LoopPhase; shouldBreak: boolean; incrementCycles: boolean } {
    if (currentPhase === "refine") {
      return { nextPhase: "research", shouldBreak: false, incrementCycles: false };
    }
    if (currentPhase === "research") {
      return { nextPhase: "restructure", shouldBreak: false, incrementCycles: false };
    }
    // restructure
    if (phaseCycles + 1 < maxCycles) {
      return { nextPhase: "refine", shouldBreak: false, incrementCycles: true };
    }
    return { nextPhase: currentPhase, shouldBreak: true, incrementCycles: true };
  },

  /**
   * Adjust verdict when trades are below minTrades.
   * - accept → neutral (don't save checkpoint for statistically weak results)
   * - neutral → reject (trigger rollback to prevent cascading degradation)
   */
  computeEffectiveVerdict(
    scoreVerdict: ScoreVerdict,
    meetsMinTrades: boolean,
  ): ScoreVerdict {
    if (!meetsMinTrades) {
      if (scoreVerdict === "accept") return "neutral";
      if (scoreVerdict === "neutral") return "reject";
    }
    return scoreVerdict;
  },

  /**
   * Progressive early-kill. Returns kill reason or null.
   * Thresholds derived from MODULE_CRITERIA (not hardcoded).
   *
   * - Universal: PF < 0.3 → kill immediately (any iter)
   * - Iter 5: bestPF < minPF × 0.4
   * - Iter 9: bestPF < minPF × 0.6
   * - Iter 12: bestPF < minPF × 0.8
   */
  shouldKillVariant(
    bestPFEver: number,
    variantIterCount: number,
    moduleId: string,
    bestAvgR?: number,
  ): string | null {
    // Universal floor (any iter)
    if (bestPFEver < 0.3) return `PF ${bestPFEver.toFixed(2)} < 0.3 (universal floor)`;

    const mc = MODULE_CRITERIA[moduleId];
    const minPF = mc?.minPF ?? 1.3;

    // Iter 5 checkpoint
    if (variantIterCount >= 5 && bestPFEver < minPF * 0.4) {
      return `PF ${bestPFEver.toFixed(2)} < ${(minPF * 0.4).toFixed(2)} (40% of ${moduleId} minPF=${minPF} at iter ${variantIterCount})`;
    }

    // Iter 9 checkpoint: PF gate OR negative per-trade expectancy (KB §13.2)
    if (variantIterCount >= 9 && bestPFEver < minPF * 0.6) {
      return `PF ${bestPFEver.toFixed(2)} < ${(minPF * 0.6).toFixed(2)} (60% of ${moduleId} minPF=${minPF} at iter ${variantIterCount})`;
    }
    if (variantIterCount >= 9 && bestAvgR !== undefined && bestAvgR < 0) {
      return `avgR ${bestAvgR.toFixed(3)} < 0 (negative per-trade expectancy at iter ${variantIterCount})`;
    }

    // Iter 12 checkpoint — late-stage gate, variant must be near target
    if (variantIterCount >= 12 && bestPFEver < minPF * 0.8) {
      return `PF ${bestPFEver.toFixed(2)} < ${(minPF * 0.8).toFixed(2)} (80% of ${moduleId} minPF=${minPF} at iter ${variantIterCount})`;
    }

    return null;
  },

  /**
   * Compute effective per-variant budget based on how close the variant's
   * best metrics are to the target criteria, plus a "lever" bonus when there
   * is a clear optimization lever (many trades to filter, or good edge to relax).
   *
   * Proximity multiplier:
   *   4-5 criteria passing → 2.0x
   *   3 criteria passing   → 1.5x
   *   2 criteria passing   → 1.0x
   *   0-1 criteria passing → 0.6x
   *
   * Lever bonus (min 1.3x):
   *   - numTrades > minTrades × 2 AND PF < minPF → optimizer can filter
   *   - numTrades < minTrades × 0.8 AND PF >= minPF → optimizer can relax
   *
   * Final multiplier = max(proximity, lever), capped at baseBudget × 2.5.
   */
  computeEffectiveBudget(opts: {
    baseBudget: number;
    bestMetrics: { profitFactor: number; numTrades: number; maxDrawdownPct: number; avgR: number; winRate: number };
    criteria: { minPF: number; minTrades: number; maxDD: number; minAvgR: number | null; minWR: number | null };
  }): number {
    const { baseBudget, bestMetrics, criteria } = opts;

    // Count how many criteria are passing
    let passing = 0;
    let total = 0;

    // PF
    total++;
    if (bestMetrics.profitFactor >= criteria.minPF) passing++;

    // Trades
    total++;
    if (bestMetrics.numTrades >= criteria.minTrades) passing++;

    // DD (lower is better)
    total++;
    if (bestMetrics.maxDrawdownPct <= criteria.maxDD) passing++;

    // avgR (null gate = auto-pass)
    total++;
    if (criteria.minAvgR === null || bestMetrics.avgR >= criteria.minAvgR) passing++;

    // WR (null gate = auto-pass)
    total++;
    if (criteria.minWR === null || bestMetrics.winRate >= criteria.minWR) passing++;

    // Proximity multiplier
    const ratio = total > 0 ? passing / total : 0;
    let proximityMult: number;
    if (ratio >= 0.8) {          // 4/5 or 5/5
      proximityMult = 2.0;
    } else if (ratio >= 0.6) {   // 3/5
      proximityMult = 1.5;
    } else if (ratio >= 0.4) {   // 2/5
      proximityMult = 1.0;
    } else {                     // 0/5 or 1/5
      proximityMult = 0.6;
    }

    // Lever bonus: clear optimization lever present
    let leverMult = 0;
    const highTrades = bestMetrics.numTrades > criteria.minTrades * 2;
    const lowPF = bestMetrics.profitFactor < criteria.minPF;
    const lowTrades = bestMetrics.numTrades < criteria.minTrades * 0.8;
    const highPF = bestMetrics.profitFactor >= criteria.minPF;

    if ((highTrades && lowPF) || (lowTrades && highPF)) {
      leverMult = 1.3;
    }

    const effectiveMult = Math.max(proximityMult, leverMult);
    const cap = baseBudget * 2.5;
    return Math.min(Math.round(baseBudget * effectiveMult), cap);
  },
};
