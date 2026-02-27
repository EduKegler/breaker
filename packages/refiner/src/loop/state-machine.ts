/**
 * state-machine.ts — xstate v5 state machine for the B.R.E.A.K.E.R. orchestrator.
 *
 * Manages phase transitions (refine/research/restructure/done), escalation logic,
 * error recovery counters, and verdict tracking. The orchestrator's for-loop still
 * drives iteration flow; this machine ADVISES state, it does not control flow.
 */

import { setup, assign } from "xstate";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
interface BreakerContext {
  /** Which phase was requested at startup (used by init state routing only). */
  initialPhase: "refine" | "research" | "restructure";
  phaseIterCount: number;
  neutralStreak: number;
  noChangeCount: number;
  fixAttempts: number;
  transientFailures: number;
  phaseCycles: number;
  maxCycles: number;
  bestScore: number;
  bestPnl: number;
  bestIter: number;
  currentScore: number;
  needsRebuild: boolean;
  researchBriefPath: string | undefined;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
type BreakerEvent =
  | { type: "ITER_START" }
  | { type: "ESCALATE" }
  | { type: "PHASE_TIMEOUT" }
  | { type: "VERDICT"; verdict: "improved" | "degraded" | "neutral" }
  | { type: "NO_CHANGE" }
  | { type: "CHANGE_APPLIED"; isRestructure?: boolean }
  | { type: "COMPILE_ERROR" }
  | { type: "TRANSIENT_ERROR" }
  | { type: "BACKTEST_OK"; currentScore: number; currentPnl: number }
  | { type: "CHECKPOINT_SAVED"; bestScore: number; bestPnl: number; bestIter: number }
  | { type: "CRITERIA_MET" }
  | { type: "RESEARCH_DONE"; briefPath: string }
  | { type: "SET_NEEDS_REBUILD"; value: boolean };

// ---------------------------------------------------------------------------
// Input (used to configure initial state and context)
// ---------------------------------------------------------------------------
export interface BreakerInput {
  initialPhase?: "refine" | "research" | "restructure";
  phaseIterCount?: number;
  neutralStreak?: number;
  noChangeCount?: number;
  fixAttempts?: number;
  transientFailures?: number;
  phaseCycles?: number;
  maxCycles?: number;
  bestScore?: number;
  bestPnl?: number;
  bestIter?: number;
  currentScore?: number;
  needsRebuild?: boolean;
  researchBriefPath?: string;
}

// ---------------------------------------------------------------------------
// Common event handlers shared across active phase states
// ---------------------------------------------------------------------------
const commonPhaseEvents = {
  ITER_START: { actions: "incrementPhaseIter" as const },
  VERDICT: [
    { guard: "isNeutralVerdict" as const, actions: "incrementNeutralStreak" as const },
    { actions: "resetNeutralStreak" as const },
  ],
  NO_CHANGE: { actions: "incrementNoChange" as const },
  CHANGE_APPLIED: { actions: "applyChange" as const },
  COMPILE_ERROR: { actions: "incrementFixAttempts" as const },
  TRANSIENT_ERROR: { actions: "incrementTransient" as const },
  BACKTEST_OK: { actions: ["resetErrors" as const, "updateCurrentScore" as const] },
  CHECKPOINT_SAVED: { actions: "updateBest" as const },
  CRITERIA_MET: { target: "done" as const },
  SET_NEEDS_REBUILD: { actions: "setNeedsRebuild" as const },
};

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------
export const breakerMachine = setup({
  types: {
    context: {} as BreakerContext,
    events: {} as BreakerEvent,
    input: {} as BreakerInput,
  },
  guards: {
    isInitialResearch: ({ context }) => context.initialPhase === "research",
    isInitialRestructure: ({ context }) => context.initialPhase === "restructure",

    shouldEscalateRefine: ({ context }) =>
      (context.neutralStreak >= 3 || context.noChangeCount >= 2) &&
      context.phaseCycles < context.maxCycles,

    shouldEscalateResearchOrRestructure: ({ context }) =>
      context.noChangeCount >= 2,

    canEscalateRestructureToRefine: ({ context }) =>
      context.noChangeCount >= 2 && context.phaseCycles + 1 < context.maxCycles,

    canEscalateRestructureToDone: ({ context }) =>
      context.noChangeCount >= 2 && context.phaseCycles + 1 >= context.maxCycles,

    hasMoreCycles: ({ context }) =>
      context.phaseCycles + 1 < context.maxCycles,

    noMoreCycles: ({ context }) =>
      context.phaseCycles + 1 >= context.maxCycles,

    isNeutralVerdict: ({ event }) =>
      event.type === "VERDICT" && event.verdict === "neutral",
  },
  actions: {
    resetPhaseCounters: assign({
      fixAttempts: 0,
      transientFailures: 0,
      neutralStreak: 0,
      noChangeCount: 0,
      phaseIterCount: 0,
    }),
    incrementPhaseIter: assign({
      phaseIterCount: ({ context }) => context.phaseIterCount + 1,
    }),
    incrementFixAttempts: assign({
      fixAttempts: ({ context }) => context.fixAttempts + 1,
      needsRebuild: true,
    }),
    incrementTransient: assign({
      transientFailures: ({ context }) => context.transientFailures + 1,
    }),
    resetErrors: assign({
      fixAttempts: 0,
      transientFailures: 0,
    }),
    incrementNeutralStreak: assign({
      neutralStreak: ({ context }) => context.neutralStreak + 1,
    }),
    resetNeutralStreak: assign({
      neutralStreak: 0,
    }),
    incrementNoChange: assign({
      noChangeCount: ({ context }) => context.noChangeCount + 1,
    }),
    resetNoChange: assign({
      noChangeCount: 0,
    }),
    incrementPhaseCycles: assign({
      phaseCycles: ({ context }) => context.phaseCycles + 1,
    }),
    clearResearchBriefPath: assign({
      researchBriefPath: (_: unknown) => undefined as string | undefined,
    }),
    updateCurrentScore: assign({
      currentScore: ({ event }) => {
        if (event.type === "BACKTEST_OK") return event.currentScore;
        return 0;
      },
    }),
    updateBest: assign({
      bestScore: ({ event }) => {
        if (event.type === "CHECKPOINT_SAVED") return event.bestScore;
        return 0;
      },
      bestPnl: ({ event }) => {
        if (event.type === "CHECKPOINT_SAVED") return event.bestPnl;
        return 0;
      },
      bestIter: ({ event }) => {
        if (event.type === "CHECKPOINT_SAVED") return event.bestIter;
        return 0;
      },
    }),
    setResearchBriefPath: assign({
      researchBriefPath: ({ event }) => {
        if (event.type === "RESEARCH_DONE") return event.briefPath;
        return undefined;
      },
    }),
    setNeedsRebuild: assign({
      needsRebuild: ({ event }) => {
        if (event.type === "SET_NEEDS_REBUILD") return event.value;
        return false;
      },
    }),
    applyChange: assign({
      noChangeCount: 0,
      needsRebuild: ({ context, event }) => {
        if (event.type === "CHANGE_APPLIED" && event.isRestructure) return true;
        return context.needsRebuild;
      },
    }),
  },
}).createMachine({
  id: "breaker",
  context: ({ input }) => ({
    initialPhase: input?.initialPhase ?? "refine",
    phaseIterCount: input?.phaseIterCount ?? 0,
    neutralStreak: input?.neutralStreak ?? 0,
    noChangeCount: input?.noChangeCount ?? 0,
    fixAttempts: input?.fixAttempts ?? 0,
    transientFailures: input?.transientFailures ?? 0,
    phaseCycles: input?.phaseCycles ?? 0,
    maxCycles: input?.maxCycles ?? 2,
    bestScore: input?.bestScore ?? 0,
    bestPnl: input?.bestPnl ?? 0,
    bestIter: input?.bestIter ?? 0,
    currentScore: input?.currentScore ?? 0,
    needsRebuild: input?.needsRebuild ?? false,
    researchBriefPath: input?.researchBriefPath,
  }),
  initial: "init",
  states: {
    // Transient routing state — immediately transitions to the requested phase
    init: {
      always: [
        { target: "research", guard: "isInitialResearch" },
        { target: "restructure", guard: "isInitialRestructure" },
        { target: "refine" },
      ],
    },

    refine: {
      on: {
        ...commonPhaseEvents,
        ESCALATE: [
          {
            target: "research",
            guard: "shouldEscalateRefine",
            actions: "resetPhaseCounters",
          },
        ],
        PHASE_TIMEOUT: {
          target: "research",
          actions: "resetPhaseCounters",
        },
      },
    },

    research: {
      on: {
        ...commonPhaseEvents,
        ESCALATE: [
          {
            target: "restructure",
            guard: "shouldEscalateResearchOrRestructure",
            actions: "resetPhaseCounters",
          },
        ],
        PHASE_TIMEOUT: {
          target: "restructure",
          actions: "resetPhaseCounters",
        },
        RESEARCH_DONE: { actions: "setResearchBriefPath" },
      },
    },

    restructure: {
      on: {
        ...commonPhaseEvents,
        ESCALATE: [
          {
            target: "refine",
            guard: "canEscalateRestructureToRefine",
            actions: ["resetPhaseCounters", "incrementPhaseCycles", "clearResearchBriefPath"],
          },
          {
            target: "done",
            guard: "canEscalateRestructureToDone",
            actions: ["incrementPhaseCycles"],
          },
        ],
        PHASE_TIMEOUT: [
          {
            target: "refine",
            guard: "hasMoreCycles",
            actions: ["resetPhaseCounters", "incrementPhaseCycles", "clearResearchBriefPath"],
          },
          {
            target: "done",
            guard: "noMoreCycles",
            actions: ["incrementPhaseCycles"],
          },
        ],
        RESEARCH_DONE: { actions: "setResearchBriefPath" },
      },
    },

    done: {
      type: "final",
    },
  },
});
