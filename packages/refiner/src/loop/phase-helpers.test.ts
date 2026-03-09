import { describe, it, expect } from "vitest";
import { phaseHelpers } from "./phase-helpers.js";
import type { IterationState, LoopConfig } from "./types.js";

function makeState(overrides: Partial<IterationState> = {}): IterationState {
  return {
    iter: 1, globalIter: 1, bestPnl: 0, bestIter: 0, fixAttempts: 0,
    transientFailures: 0, noChangeCount: 0, previousPnl: 0, sessionMetrics: [],
    currentPhase: "refine", currentScore: 0, bestScore: 0, neutralStreak: 0, phaseCycles: 0,
    ...overrides,
  };
}

const stubCfg = {} as LoopConfig;

describe("shouldEscalate", () => {
  it("escalates refine on neutralStreak >= 3", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", neutralStreak: 3 }), stubCfg)).toBe(true);
  });

  it("escalates refine on noChangeCount >= 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", noChangeCount: 2 }), stubCfg)).toBe(true);
  });

  it("does NOT escalate refine on wfRejectStreak alone (WF overfit ≠ plateau)", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", wfRejectStreak: 5 }), stubCfg)).toBe(false);
  });

  it("does not escalate refine when all counters below threshold", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", neutralStreak: 1, noChangeCount: 1, wfRejectStreak: 1 }), stubCfg)).toBe(false);
  });

  it("escalates research on noChangeCount >= 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "research", noChangeCount: 2 }), stubCfg)).toBe(true);
  });

  it("does NOT escalate research on wfRejectStreak alone", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "research", wfRejectStreak: 5 }), stubCfg)).toBe(false);
  });

  it("does not escalate research when only neutralStreak is high", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "research", neutralStreak: 10, noChangeCount: 0, wfRejectStreak: 0 }), stubCfg)).toBe(false);
  });

  it("does NOT escalate restructure on wfRejectStreak alone", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "restructure", wfRejectStreak: 5 }), stubCfg)).toBe(false);
  });

  it("escalates restructure on noChangeCount >= 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "restructure", noChangeCount: 2 }), stubCfg)).toBe(true);
  });

  it("does not escalate restructure when wfRejectStreak < 2 and noChangeCount < 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "restructure", wfRejectStreak: 1, noChangeCount: 1 }), stubCfg)).toBe(false);
  });
});

describe("computeEffectiveVerdict", () => {
  it("preserves accept when meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("accept", true)).toBe("accept");
  });

  it("preserves neutral when meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("neutral", true)).toBe("neutral");
  });

  it("preserves reject when meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("reject", true)).toBe("reject");
  });

  it("downgrades accept to neutral when !meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("accept", false)).toBe("neutral");
  });

  it("downgrades neutral to reject when !meetsMinTrades (Bug A: cascading degradation)", () => {
    // Before fix: neutral stayed neutral, no rollback happened, allowing
    // a 30-trade strategy (below minTrades=50) to survive and further degrade to 2 trades.
    expect(phaseHelpers.computeEffectiveVerdict("neutral", false)).toBe("reject");
  });

  it("keeps reject as reject when !meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("reject", false)).toBe("reject");
  });
});

describe("shouldKillVariant", () => {
  it("kills when PF < 0.3 at any iter", () => {
    const reason = phaseHelpers.shouldKillVariant(0.25, 1, "M1");
    expect(reason).toContain("0.3");
    expect(reason).toContain("universal floor");
  });

  it("survives PF >= 0.3 at iter 1", () => {
    expect(phaseHelpers.shouldKillVariant(0.5, 1, "M1")).toBeNull();
  });

  it("survives at iter 3 (no checkpoint at iter 3 anymore)", () => {
    // Old: killed at iter 3 with PF < 0.78. New: no checkpoint until iter 5
    expect(phaseHelpers.shouldKillVariant(0.5, 3, "M1")).toBeNull();
  });

  it("kills at iter 5 when PF < 40% of M1 minPF", () => {
    // M1 minPF=1.3, 40% = 0.52
    const reason = phaseHelpers.shouldKillVariant(0.5, 5, "M1");
    expect(reason).not.toBeNull();
    expect(reason).toContain("40%");
    expect(reason).toContain("0.52");
  });

  it("survives at iter 5 when PF >= 40%", () => {
    // M1 minPF=1.3, 40% = 0.52; PF=0.6 passes
    expect(phaseHelpers.shouldKillVariant(0.6, 5, "M1")).toBeNull();
  });

  it("kills at iter 9 when PF < 60% of M1 minPF", () => {
    // M1 minPF=1.3, 60% = 0.78
    const reason = phaseHelpers.shouldKillVariant(0.7, 9, "M1");
    expect(reason).not.toBeNull();
    expect(reason).toContain("60%");
  });

  it("survives at iter 9 when PF >= 60%", () => {
    // M1 minPF=1.3, 60% = 0.78; PF=0.8 passes
    expect(phaseHelpers.shouldKillVariant(0.8, 9, "M1")).toBeNull();
  });

  it("kills at iter 12 when PF < 80% of M1 minPF", () => {
    // M1 minPF=1.3, 80% = 1.04; PF=0.86 fails (the squeeze-ema-atr-trail scenario)
    const reason = phaseHelpers.shouldKillVariant(0.86, 12, "M1");
    expect(reason).not.toBeNull();
    expect(reason).toContain("80%");
    expect(reason).toContain("1.04");
  });

  it("survives at iter 12 when PF >= 80%", () => {
    // M1 minPF=1.3, 80% = 1.04; PF=1.1 passes
    expect(phaseHelpers.shouldKillVariant(1.1, 12, "M1")).toBeNull();
  });

  it("uses M4 thresholds correctly", () => {
    // M4 minPF=1.4: iter5 = 0.56, iter9 = 0.84, iter12 = 1.12
    expect(phaseHelpers.shouldKillVariant(0.5, 5, "M4")).not.toBeNull();
    expect(phaseHelpers.shouldKillVariant(0.6, 5, "M4")).toBeNull();
    expect(phaseHelpers.shouldKillVariant(0.8, 9, "M4")).not.toBeNull();
    expect(phaseHelpers.shouldKillVariant(0.9, 9, "M4")).toBeNull();
    expect(phaseHelpers.shouldKillVariant(1.0, 12, "M4")).not.toBeNull();
    expect(phaseHelpers.shouldKillVariant(1.15, 12, "M4")).toBeNull();
  });

  it("falls back to minPF=1.3 for unknown moduleId", () => {
    // Unknown module → minPF=1.3 fallback, iter5 = 0.52
    const reason = phaseHelpers.shouldKillVariant(0.5, 5, "M99");
    expect(reason).not.toBeNull();
    expect(reason).toContain("0.52");
  });
});
