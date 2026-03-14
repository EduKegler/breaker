import { describe, it, expect } from "vitest";
import { applyRollback, applyB2Rollback } from "./loop-state.js";
import type { LoopMutableState, RollbackContext } from "./loop-state.js";
import type { Metrics, StrategyParam, TradeAnalysis } from "@breaker/backtest";
import type { CheckpointData } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    totalPnl: 100,
    numTrades: 80,
    profitFactor: 1.5,
    maxDrawdownPct: -8,
    winRate: 45,
    avgR: 0.15,
    avgWinR: 0.4,
    avgLossR: -0.2,
    maxLossR: -1.5,
    expectancy: 0.1,
    edgeBpsGross: null,
    edgeBpsNet: null,
    avgCostBps: null,
    tradesPerDay: null,
    totalCostPct: null,
    sharpeRatio: null,
    sortinoRatio: null,
    ...overrides,
  };
}

function makeParam(name: string, value: number): StrategyParam {
  return { name, value, min: 1, max: 100, step: 1, optimizable: true };
}

function makeState(overrides: Partial<LoopMutableState> = {}): LoopMutableState {
  return {
    lastStrategyParams: { dcPeriod: makeParam("dcPeriod", 20), volMult: makeParam("volMult", 1.5) },
    paramOverrides: { dcPeriod: 20, volMult: 1.5 },
    paramCount: 2,
    currentMetrics: makeMetrics(),
    currentPnl: 100,
    currentAnalysis: null,
    lastAnalysis: null,
    lastRollbackReason: undefined,
    failedRestructures: [],
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<CheckpointData> = {}): CheckpointData {
  return {
    strategyContent: "// checkpoint strategy",
    metrics: makeMetrics({ totalPnl: 200, numTrades: 150, profitFactor: 1.8 }),
    params: { dcPeriod: 20, volMult: 1.5 },
    paramCount: 2,
    strategyParams: { dcPeriod: makeParam("dcPeriod", 20), volMult: makeParam("volMult", 1.5) },
    iter: 5,
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRollbackCtx(overrides: Partial<RollbackContext> = {}): RollbackContext {
  return {
    iter: 10,
    phase: "refine",
    scoreWeighted: 50,
    bestScore: 60,
    effectiveVerdict: "reject",
    scoreVerdict: "reject",
    metrics: makeMetrics({ totalPnl: -50, numTrades: 10, profitFactor: 0.5 }),
    paramCount: 2,
    analysis: null,
    wfViolations: [],
    fvViolations: [],
    globalIter: 15,
    minTrades: 50,
    minPF: 1.3,
    maxDD: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyRollback
// ---------------------------------------------------------------------------

describe("applyRollback", () => {
  it("restores lastStrategyParams from checkpoint after refine rollback", () => {
    // Bug original: dcPeriod=24 (rejeitado) permanecia — Claude via "ghost params"
    const rejectedParams = {
      dcPeriod: makeParam("dcPeriod", 24),
      volMult: makeParam("volMult", 2.0),
    };
    const cpParams = {
      dcPeriod: makeParam("dcPeriod", 20),
      volMult: makeParam("volMult", 1.5),
    };

    const state = makeState({
      lastStrategyParams: rejectedParams,
      paramOverrides: { dcPeriod: 24, volMult: 2.0 },
      paramCount: 5, // stale
    });
    const cpData = makeCheckpoint({
      strategyParams: cpParams,
      params: { dcPeriod: 20, volMult: 1.5 },
      paramCount: 2,
    });

    const result = applyRollback(state, cpData, cpData.params!, makeRollbackCtx());

    expect(result.lastStrategyParams).toEqual(cpParams);
    expect(result.lastStrategyParams.dcPeriod.value).toBe(20); // checkpoint, NOT 24
  });

  it("prompt inputs after rollback reflect checkpoint, not rejected iteration", () => {
    const rejectedMetrics = makeMetrics({ totalPnl: -200, numTrades: 5, profitFactor: 0.2 });
    const cpMetrics = makeMetrics({ totalPnl: 300, numTrades: 150, profitFactor: 1.8 });
    const cpParams = { dcPeriod: makeParam("dcPeriod", 20) };

    const state = makeState({
      currentMetrics: rejectedMetrics,
      currentPnl: -200,
      paramOverrides: { dcPeriod: 30 },
      lastStrategyParams: { dcPeriod: makeParam("dcPeriod", 30) },
      paramCount: 8,
    });
    const cpData = makeCheckpoint({
      metrics: cpMetrics,
      params: { dcPeriod: 20 },
      paramCount: 1,
      strategyParams: cpParams,
    });

    const result = applyRollback(state, cpData, cpData.params!, makeRollbackCtx());

    // All three should reflect checkpoint state
    expect(result.currentMetrics).toEqual(cpMetrics);
    expect(result.currentPnl).toBe(300);
    expect(result.paramOverrides).toEqual({ dcPeriod: 20 });
    expect(result.lastStrategyParams).toEqual(cpParams);
    expect(result.paramCount).toBe(1);
  });

  it("failedRestructures accumulates only for non-refine phases", () => {
    const state = makeState({ failedRestructures: [] });
    const cpData = makeCheckpoint();

    // Refine rollback — should NOT add to failedRestructures
    const refineResult = applyRollback(state, cpData, cpData.params!, makeRollbackCtx({ phase: "refine" }));
    expect(refineResult.failedRestructures).toHaveLength(0);

    // Restructure rollback — SHOULD add
    const restructureResult = applyRollback(state, cpData, cpData.params!, makeRollbackCtx({
      phase: "restructure",
      globalIter: 18,
      metrics: makeMetrics({ numTrades: 1, profitFactor: 0 }),
      scoreWeighted: 29.9,
    }));
    expect(restructureResult.failedRestructures).toHaveLength(1);
    expect(restructureResult.failedRestructures[0]).toMatchObject({
      globalIter: 18,
      trades: 1,
      pf: 0,
      score: 29.9,
    });

    // Second restructure — accumulates (from restructureResult, which already has 1)
    const second = applyRollback(restructureResult, cpData, cpData.params!, makeRollbackCtx({
      phase: "restructure",
      globalIter: 19,
      metrics: makeMetrics({ numTrades: 3, profitFactor: 0.1 }),
      scoreWeighted: 17.9,
    }));
    expect(second.failedRestructures).toHaveLength(2);
    expect(second.failedRestructures.map((f) => f.globalIter)).toEqual([18, 19]);
  });

  it("WF overfit produces correct reason string", () => {
    const analysis = {
      walkForward: { pfRatio: 0.4, trainPF: 2.5, testPF: 0.9 },
    } as unknown as TradeAnalysis;

    const state = makeState();
    const cpData = makeCheckpoint();

    const result = applyRollback(state, cpData, cpData.params!, makeRollbackCtx({
      effectiveVerdict: "reject",
      scoreVerdict: "accept", // score was good, but guardrail rejected
      wfViolations: [{ reason: "pfRatio < 0.6" }],
      analysis,
    }));

    expect(result.lastRollbackReason).toContain("WF overfit");
    expect(result.lastRollbackReason).toContain("pfRatio=0.40");
    expect(result.lastRollbackReason).toContain("train PF=2.50");
    expect(result.lastRollbackReason).toContain("test PF=0.90");
  });

  it("neutral drift rollback reason mentions noise band", () => {
    const state = makeState();
    const cpData = makeCheckpoint();

    const result = applyRollback(state, cpData, cpData.params!, makeRollbackCtx({
      effectiveVerdict: "neutral",
      scoreVerdict: "neutral",
      scoreWeighted: 78.0,
      bestScore: 80.2,
    }));

    expect(result.lastRollbackReason).toContain("neutral");
    expect(result.lastRollbackReason).toContain("noise band");
    expect(result.lastRollbackReason).toContain("78.0");
    expect(result.lastRollbackReason).toContain("80.2");
  });

  it("score degraded produces correct reason string", () => {
    const state = makeState();
    const cpData = makeCheckpoint();

    const result = applyRollback(state, cpData, cpData.params!, makeRollbackCtx({
      effectiveVerdict: "reject",
      scoreVerdict: "reject",
      scoreWeighted: 30.0,
      bestScore: 60.0,
    }));

    expect(result.lastRollbackReason).toContain("score degraded");
    expect(result.lastRollbackReason).toContain("30.0");
    expect(result.lastRollbackReason).toContain("60.0");
  });

  it("does not mutate the input state", () => {
    const state = makeState();
    const original = { ...state, failedRestructures: [...state.failedRestructures] };
    const cpData = makeCheckpoint();

    applyRollback(state, cpData, cpData.params!, makeRollbackCtx({ phase: "restructure" }));

    expect(state.failedRestructures).toEqual(original.failedRestructures);
    expect(state.currentPnl).toBe(original.currentPnl);
  });

  it("falls back to params key count when paramCount missing from checkpoint", () => {
    const state = makeState({ paramCount: 8 });
    const cpData = makeCheckpoint({ paramCount: undefined, params: { a: 1, b: 2, c: 3 } });

    const result = applyRollback(state, cpData, cpData.params!, makeRollbackCtx());

    expect(result.paramCount).toBe(3);
  });

  it("restructure diagnosis includes all failing criteria", () => {
    const state = makeState();
    const cpData = makeCheckpoint();

    const result = applyRollback(state, cpData, cpData.params!, makeRollbackCtx({
      phase: "restructure",
      metrics: makeMetrics({ numTrades: 1, profitFactor: 0, maxDrawdownPct: -50, winRate: 10 }),
      minTrades: 50,
      minPF: 1.3,
      maxDD: 10,
      minWR: 50,
    }));

    const diag = result.failedRestructures[0].diagnosis!;
    expect(diag).toContain("trades 1 < minTrades 50");
    expect(diag).toContain("PF 0.00 < 1.3");
    expect(diag).toContain("DD 50.0% > 10%");
    expect(diag).toContain("WR 10.0% < 50%");
  });
});

// ---------------------------------------------------------------------------
// applyB2Rollback
// ---------------------------------------------------------------------------

describe("applyB2Rollback", () => {
  it("restores all checkpoint state including paramCount", () => {
    const state = makeState({
      paramCount: 8, // stale from ESM-cached factory
      currentMetrics: makeMetrics({ totalPnl: 0.14, numTrades: 1 }),
      currentPnl: 0.14,
      lastStrategyParams: { dcPeriod: makeParam("dcPeriod", 30) },
    });
    const cpData = makeCheckpoint({
      metrics: makeMetrics({ totalPnl: 200, numTrades: 150 }),
      paramCount: 3,
      params: { dcPeriod: 20, volMult: 1.5, atrMult: 3.0 },
      strategyParams: {
        dcPeriod: makeParam("dcPeriod", 20),
        volMult: makeParam("volMult", 1.5),
        atrMult: makeParam("atrMult", 3.0),
      },
    });

    const result = applyB2Rollback(state, cpData, cpData.params!);

    expect(result.paramCount).toBe(3);
    expect(result.currentPnl).toBe(200);
    expect(result.currentMetrics.numTrades).toBe(150);
    expect(result.paramOverrides).toEqual({ dcPeriod: 20, volMult: 1.5, atrMult: 3.0 });
    expect(result.lastStrategyParams.dcPeriod.value).toBe(20);
  });

  it("does not modify lastRollbackReason or failedRestructures", () => {
    const state = makeState({
      lastRollbackReason: "previous reason",
      failedRestructures: [{ globalIter: 5, trades: 10, pf: 0.5, score: 20 }],
    });
    const cpData = makeCheckpoint();

    const result = applyB2Rollback(state, cpData, cpData.params!);

    expect(result.lastRollbackReason).toBe("previous reason");
    expect(result.failedRestructures).toHaveLength(1);
  });

  it("handles null checkpoint data gracefully", () => {
    const state = makeState({ paramCount: 5, currentPnl: 100 });

    const result = applyB2Rollback(state, null, null);

    // State unchanged when no checkpoint data
    expect(result.paramCount).toBe(5);
    expect(result.currentPnl).toBe(100);
  });
});
