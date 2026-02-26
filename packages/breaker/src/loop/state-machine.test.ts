import { describe, it, expect } from "vitest";
import { createActor } from "xstate";
import {
  breakerMachine,
  type BreakerInput,
} from "./state-machine.js";

function startActor(inputOverrides: Partial<BreakerInput> = {}) {
  const actor = createActor(breakerMachine, {
    input: inputOverrides,
  });
  actor.start();
  return actor;
}

// ---------------------------------------------------------------------------
// Initial context defaults
// ---------------------------------------------------------------------------
describe("state-machine: initial context", () => {
  it("starts in refine phase by default", () => {
    const actor = startActor();
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("refine");
  });

  it("initializes all counters to zero", () => {
    const actor = startActor();
    const ctx = actor.getSnapshot().context;
    expect(ctx.phaseIterCount).toBe(0);
    expect(ctx.neutralStreak).toBe(0);
    expect(ctx.noChangeCount).toBe(0);
    expect(ctx.fixAttempts).toBe(0);
    expect(ctx.transientFailures).toBe(0);
    expect(ctx.phaseCycles).toBe(0);
    expect(ctx.bestScore).toBe(0);
    expect(ctx.bestPnl).toBe(0);
    expect(ctx.bestIter).toBe(0);
    expect(ctx.currentScore).toBe(0);
    expect(ctx.needsRebuild).toBe(false);
    expect(ctx.researchBriefPath).toBeUndefined();
  });

  it("can start in research phase", () => {
    const actor = startActor({ initialPhase: "research" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("can start in restructure phase", () => {
    const actor = startActor({ initialPhase: "restructure" });
    expect(actor.getSnapshot().value).toBe("restructure");
  });

  it("can start with pre-loaded best scores", () => {
    const actor = startActor({ bestScore: 55.5, bestPnl: 200, bestIter: 3 });
    const ctx = actor.getSnapshot().context;
    expect(ctx.bestScore).toBe(55.5);
    expect(ctx.bestPnl).toBe(200);
    expect(ctx.bestIter).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ITER_START event
// ---------------------------------------------------------------------------
describe("state-machine: ITER_START", () => {
  it("increments phaseIterCount on ITER_START", () => {
    const actor = startActor();
    actor.send({ type: "ITER_START" });
    expect(actor.getSnapshot().context.phaseIterCount).toBe(1);
    actor.send({ type: "ITER_START" });
    expect(actor.getSnapshot().context.phaseIterCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Phase escalation: refine -> research
// ---------------------------------------------------------------------------
describe("state-machine: escalation refine -> research", () => {
  it("escalates when neutralStreak >= 3", () => {
    const actor = startActor({ neutralStreak: 3, maxCycles: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("escalates when noChangeCount >= 2", () => {
    const actor = startActor({ noChangeCount: 2, maxCycles: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("does NOT escalate when neutralStreak=2 and noChangeCount=1", () => {
    const actor = startActor({ neutralStreak: 2, noChangeCount: 1 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("refine");
  });

  it("resets phase counters on escalation", () => {
    const actor = startActor({
      neutralStreak: 3,
      noChangeCount: 1,
      fixAttempts: 2,
      transientFailures: 1,
      phaseIterCount: 5,
      maxCycles: 2,
    });
    actor.send({ type: "ESCALATE" });
    const ctx = actor.getSnapshot().context;
    expect(ctx.neutralStreak).toBe(0);
    expect(ctx.noChangeCount).toBe(0);
    expect(ctx.fixAttempts).toBe(0);
    expect(ctx.transientFailures).toBe(0);
    expect(ctx.phaseIterCount).toBe(0);
  });

  it("does NOT escalate refine -> research when phaseCycles >= maxCycles", () => {
    const actor = startActor({ neutralStreak: 3, phaseCycles: 2, maxCycles: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("refine");
  });
});

// ---------------------------------------------------------------------------
// Phase escalation: research -> restructure
// ---------------------------------------------------------------------------
describe("state-machine: escalation research -> restructure", () => {
  it("escalates when noChangeCount >= 2", () => {
    const actor = startActor({ initialPhase: "research", noChangeCount: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("restructure");
  });

  it("does NOT escalate when noChangeCount < 2", () => {
    const actor = startActor({ initialPhase: "research", noChangeCount: 1, neutralStreak: 10 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("resets phase counters on escalation", () => {
    const actor = startActor({
      initialPhase: "research",
      noChangeCount: 2,
      fixAttempts: 1,
      transientFailures: 2,
      neutralStreak: 5,
      phaseIterCount: 3,
    });
    actor.send({ type: "ESCALATE" });
    const ctx = actor.getSnapshot().context;
    expect(ctx.noChangeCount).toBe(0);
    expect(ctx.fixAttempts).toBe(0);
    expect(ctx.transientFailures).toBe(0);
    expect(ctx.neutralStreak).toBe(0);
    expect(ctx.phaseIterCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase escalation: restructure -> refine (new cycle)
// ---------------------------------------------------------------------------
describe("state-machine: escalation restructure -> refine", () => {
  it("escalates when noChangeCount >= 2 and phaseCycles < maxCycles", () => {
    const actor = startActor({ initialPhase: "restructure", noChangeCount: 2, phaseCycles: 0, maxCycles: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("refine");
    expect(actor.getSnapshot().context.phaseCycles).toBe(1);
  });

  it("transitions to done when phaseCycles + 1 >= maxCycles", () => {
    const actor = startActor({ initialPhase: "restructure", noChangeCount: 2, phaseCycles: 1, maxCycles: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("resets phase counters and clears researchBriefPath (BUG FIX)", () => {
    const actor = startActor({
      initialPhase: "restructure",
      noChangeCount: 2,
      phaseCycles: 0,
      maxCycles: 3,
      researchBriefPath: "/some/path/brief.json",
      neutralStreak: 2,
      fixAttempts: 1,
      transientFailures: 1,
      phaseIterCount: 4,
    });
    actor.send({ type: "ESCALATE" });
    const ctx = actor.getSnapshot().context;
    expect(ctx.researchBriefPath).toBeUndefined();
    expect(ctx.neutralStreak).toBe(0);
    expect(ctx.noChangeCount).toBe(0);
    expect(ctx.fixAttempts).toBe(0);
    expect(ctx.transientFailures).toBe(0);
    expect(ctx.phaseIterCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase transition on max iter: PHASE_TIMEOUT
// ---------------------------------------------------------------------------
describe("state-machine: PHASE_TIMEOUT transitions", () => {
  it("refine -> research on PHASE_TIMEOUT", () => {
    const actor = startActor();
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("research -> restructure on PHASE_TIMEOUT", () => {
    const actor = startActor({ initialPhase: "research" });
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("restructure");
  });

  it("restructure -> refine on PHASE_TIMEOUT when phaseCycles < maxCycles", () => {
    const actor = startActor({ initialPhase: "restructure", phaseCycles: 0, maxCycles: 2 });
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("refine");
    expect(actor.getSnapshot().context.phaseCycles).toBe(1);
  });

  it("restructure -> done on PHASE_TIMEOUT when phaseCycles + 1 >= maxCycles", () => {
    const actor = startActor({ initialPhase: "restructure", phaseCycles: 1, maxCycles: 2 });
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("resets phase counters on PHASE_TIMEOUT", () => {
    const actor = startActor({
      neutralStreak: 3,
      noChangeCount: 2,
      fixAttempts: 1,
      transientFailures: 1,
      phaseIterCount: 5,
    });
    actor.send({ type: "PHASE_TIMEOUT" });
    const ctx = actor.getSnapshot().context;
    expect(ctx.neutralStreak).toBe(0);
    expect(ctx.noChangeCount).toBe(0);
    expect(ctx.fixAttempts).toBe(0);
    expect(ctx.transientFailures).toBe(0);
    expect(ctx.phaseIterCount).toBe(0);
  });

  it("BUG FIX: phaseIterCount resets to 0 on PHASE_TIMEOUT (not 1)", () => {
    const actor = startActor({ phaseIterCount: 6 });
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().context.phaseIterCount).toBe(0);
  });

  it("BUG FIX: researchBriefPath is cleared on PHASE_TIMEOUT restructure -> refine", () => {
    const actor = startActor({
      initialPhase: "restructure",
      phaseCycles: 0,
      maxCycles: 2,
      researchBriefPath: "/some/brief.json",
    });
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("refine");
    expect(actor.getSnapshot().context.researchBriefPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Verdict tracking
// ---------------------------------------------------------------------------
describe("state-machine: verdict tracking", () => {
  it("VERDICT improved resets neutralStreak", () => {
    const actor = startActor({ neutralStreak: 5 });
    actor.send({ type: "VERDICT", verdict: "improved" });
    expect(actor.getSnapshot().context.neutralStreak).toBe(0);
  });

  it("VERDICT degraded resets neutralStreak", () => {
    const actor = startActor({ neutralStreak: 5 });
    actor.send({ type: "VERDICT", verdict: "degraded" });
    expect(actor.getSnapshot().context.neutralStreak).toBe(0);
  });

  it("VERDICT neutral increments neutralStreak", () => {
    const actor = startActor({ neutralStreak: 2 });
    actor.send({ type: "VERDICT", verdict: "neutral" });
    expect(actor.getSnapshot().context.neutralStreak).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// NO_CHANGE event
// ---------------------------------------------------------------------------
describe("state-machine: NO_CHANGE", () => {
  it("increments noChangeCount", () => {
    const actor = startActor({ noChangeCount: 0 });
    actor.send({ type: "NO_CHANGE" });
    expect(actor.getSnapshot().context.noChangeCount).toBe(1);
    actor.send({ type: "NO_CHANGE" });
    expect(actor.getSnapshot().context.noChangeCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CHANGE_APPLIED event (resets noChangeCount)
// ---------------------------------------------------------------------------
describe("state-machine: CHANGE_APPLIED", () => {
  it("resets noChangeCount to 0", () => {
    const actor = startActor({ noChangeCount: 3 });
    actor.send({ type: "CHANGE_APPLIED" });
    expect(actor.getSnapshot().context.noChangeCount).toBe(0);
  });

  it("sets needsRebuild when isRestructure is true", () => {
    const actor = startActor({ initialPhase: "restructure", noChangeCount: 1 });
    actor.send({ type: "CHANGE_APPLIED", isRestructure: true });
    const ctx = actor.getSnapshot().context;
    expect(ctx.noChangeCount).toBe(0);
    expect(ctx.needsRebuild).toBe(true);
  });

  it("preserves needsRebuild when isRestructure is not set", () => {
    const actor = startActor({ needsRebuild: true });
    actor.send({ type: "CHANGE_APPLIED" });
    expect(actor.getSnapshot().context.needsRebuild).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error recovery: COMPILE_ERROR
// ---------------------------------------------------------------------------
describe("state-machine: COMPILE_ERROR", () => {
  it("increments fixAttempts", () => {
    const actor = startActor({ fixAttempts: 0 });
    actor.send({ type: "COMPILE_ERROR" });
    expect(actor.getSnapshot().context.fixAttempts).toBe(1);
  });

  it("sets needsRebuild=true", () => {
    const actor = startActor({ needsRebuild: false });
    actor.send({ type: "COMPILE_ERROR" });
    expect(actor.getSnapshot().context.needsRebuild).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error recovery: TRANSIENT_ERROR
// ---------------------------------------------------------------------------
describe("state-machine: TRANSIENT_ERROR", () => {
  it("increments transientFailures", () => {
    const actor = startActor({ transientFailures: 0 });
    actor.send({ type: "TRANSIENT_ERROR" });
    expect(actor.getSnapshot().context.transientFailures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BACKTEST_OK event (resets error counters)
// ---------------------------------------------------------------------------
describe("state-machine: BACKTEST_OK", () => {
  it("resets fixAttempts and transientFailures on success", () => {
    const actor = startActor({ fixAttempts: 2, transientFailures: 1 });
    actor.send({ type: "BACKTEST_OK", currentScore: 50, currentPnl: 100 });
    const ctx = actor.getSnapshot().context;
    expect(ctx.fixAttempts).toBe(0);
    expect(ctx.transientFailures).toBe(0);
  });

  it("updates currentScore", () => {
    const actor = startActor();
    actor.send({ type: "BACKTEST_OK", currentScore: 72.5, currentPnl: 300 });
    expect(actor.getSnapshot().context.currentScore).toBe(72.5);
  });
});

// ---------------------------------------------------------------------------
// CHECKPOINT_SAVED event
// ---------------------------------------------------------------------------
describe("state-machine: CHECKPOINT_SAVED", () => {
  it("updates bestScore, bestPnl, and bestIter", () => {
    const actor = startActor();
    actor.send({ type: "CHECKPOINT_SAVED", bestScore: 80, bestPnl: 500, bestIter: 7 });
    const ctx = actor.getSnapshot().context;
    expect(ctx.bestScore).toBe(80);
    expect(ctx.bestPnl).toBe(500);
    expect(ctx.bestIter).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// CRITERIA_MET event -> done
// ---------------------------------------------------------------------------
describe("state-machine: CRITERIA_MET", () => {
  it("transitions to done from refine", () => {
    const actor = startActor();
    actor.send({ type: "CRITERIA_MET" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("transitions to done from research", () => {
    const actor = startActor({ initialPhase: "research" });
    actor.send({ type: "CRITERIA_MET" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("transitions to done from restructure", () => {
    const actor = startActor({ initialPhase: "restructure" });
    actor.send({ type: "CRITERIA_MET" });
    expect(actor.getSnapshot().value).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// RESEARCH_DONE event
// ---------------------------------------------------------------------------
describe("state-machine: RESEARCH_DONE", () => {
  it("sets researchBriefPath when research succeeds", () => {
    const actor = startActor({ initialPhase: "research" });
    actor.send({ type: "RESEARCH_DONE", briefPath: "/artifacts/research-brief.json" });
    expect(actor.getSnapshot().context.researchBriefPath).toBe("/artifacts/research-brief.json");
  });
});

// ---------------------------------------------------------------------------
// SET_NEEDS_REBUILD
// ---------------------------------------------------------------------------
describe("state-machine: SET_NEEDS_REBUILD", () => {
  it("sets needsRebuild to the given value", () => {
    const actor = startActor({ needsRebuild: true });
    actor.send({ type: "SET_NEEDS_REBUILD", value: false });
    expect(actor.getSnapshot().context.needsRebuild).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard conditions
// ---------------------------------------------------------------------------
describe("state-machine: guard conditions", () => {
  it("shouldEscalateRefine: true when neutralStreak >= 3", () => {
    const actor = startActor({ neutralStreak: 3, maxCycles: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("shouldEscalateRefine: true when noChangeCount >= 2", () => {
    const actor = startActor({ noChangeCount: 2, maxCycles: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("shouldEscalateRefine: false when both below threshold", () => {
    const actor = startActor({ neutralStreak: 2, noChangeCount: 1 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("refine");
  });

  it("shouldEscalateResearchOrRestructure: true when noChangeCount >= 2", () => {
    const actor = startActor({ initialPhase: "research", noChangeCount: 2 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("restructure");
  });

  it("shouldEscalateResearchOrRestructure: false when noChangeCount < 2", () => {
    const actor = startActor({ initialPhase: "research", noChangeCount: 1, neutralStreak: 10 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("research");
  });

  it("hasMoreCycles: allows restructure -> refine when phaseCycles < maxCycles", () => {
    const actor = startActor({ initialPhase: "restructure", noChangeCount: 2, phaseCycles: 0, maxCycles: 3 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("refine");
  });

  it("noMoreCycles: transitions to done when phaseCycles + 1 >= maxCycles", () => {
    const actor = startActor({ initialPhase: "restructure", noChangeCount: 2, phaseCycles: 2, maxCycles: 3 });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// done state is final
// ---------------------------------------------------------------------------
describe("state-machine: done state", () => {
  it("is a final state — no further transitions", () => {
    const actor = startActor();
    actor.send({ type: "CRITERIA_MET" });
    expect(actor.getSnapshot().value).toBe("done");
    // Sending more events should not change state
    actor.send({ type: "ITER_START" });
    expect(actor.getSnapshot().value).toBe("done");
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Integration: full escalation cycle
// ---------------------------------------------------------------------------
describe("state-machine: full cycle integration", () => {
  it("refine -> research -> restructure -> refine -> ... -> done", () => {
    const actor = startActor({ maxCycles: 2 });

    // Start in refine
    expect(actor.getSnapshot().value).toBe("refine");

    // Simulate neutral streak -> escalate to research
    actor.send({ type: "VERDICT", verdict: "neutral" });
    actor.send({ type: "VERDICT", verdict: "neutral" });
    actor.send({ type: "VERDICT", verdict: "neutral" });
    expect(actor.getSnapshot().context.neutralStreak).toBe(3);
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("research");

    // Simulate no-change -> escalate to restructure
    actor.send({ type: "NO_CHANGE" });
    actor.send({ type: "NO_CHANGE" });
    expect(actor.getSnapshot().context.noChangeCount).toBe(2);
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("restructure");
    expect(actor.getSnapshot().context.noChangeCount).toBe(0);

    // Simulate no-change -> cycle back to refine
    actor.send({ type: "NO_CHANGE" });
    actor.send({ type: "NO_CHANGE" });
    actor.send({ type: "ESCALATE" });
    expect(actor.getSnapshot().value).toBe("refine");
    expect(actor.getSnapshot().context.phaseCycles).toBe(1);

    // Second cycle: use PHASE_TIMEOUT to advance through phases
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("research");
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("restructure");
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("criteria met short-circuits regardless of phase", () => {
    const actor = startActor({ maxCycles: 3 });

    // Advance to research
    actor.send({ type: "PHASE_TIMEOUT" });
    expect(actor.getSnapshot().value).toBe("research");

    // Criteria met ends the machine
    actor.send({ type: "CRITERIA_MET" });
    expect(actor.getSnapshot().value).toBe("done");
    expect(actor.getSnapshot().status).toBe("done");
  });
});
