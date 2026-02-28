import type { ScoreVerdict } from "./stages/scoring.js";
import type { IterationState, LoopConfig, LoopPhase } from "./types.js";

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
   * Downgrade "accept" verdict to "neutral" when trades are below minTrades.
   */
  computeEffectiveVerdict(
    scoreVerdict: ScoreVerdict,
    meetsMinTrades: boolean,
  ): ScoreVerdict {
    if (scoreVerdict === "accept" && !meetsMinTrades) return "neutral";
    return scoreVerdict;
  },
};
