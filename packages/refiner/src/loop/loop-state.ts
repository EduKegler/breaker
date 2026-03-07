import type { Metrics, StrategyParam, TradeAnalysis } from "@breaker/backtest";
import type { CheckpointData } from "./types.js";
import type { RestructureFailure } from "../automation/build-optimize-prompt.js";
import type { LoopPhase } from "./types.js";

/**
 * Mutable state fields managed by the optimization loop that are
 * affected by rollback operations. The loop keeps these as individual
 * `let` variables — this interface is only used at rollback boundaries
 * to snapshot/restore via pure functions.
 */
export interface LoopMutableState {
  lastStrategyParams: Record<string, StrategyParam>;
  paramOverrides: Record<string, number>;
  paramCount: number;
  currentMetrics: Metrics;
  currentPnl: number;
  currentAnalysis: TradeAnalysis | null;
  lastAnalysis: TradeAnalysis | null;
  lastRollbackReason: string | undefined;
  failedRestructures: RestructureFailure[];
}

export interface RollbackContext {
  iter: number;
  phase: LoopPhase;
  scoreWeighted: number;
  bestScore: number;
  effectiveVerdict: string;
  scoreVerdict: string;
  metrics: Metrics;
  paramCount: number;
  analysis: TradeAnalysis | null;
  wfViolations: { reason: string }[];
  fvViolations: { reason: string }[];
  maxFreeVariables?: number;
  globalIter: number;
  minTrades: number;
  minPF: number;
  maxDD: number;
  minWR?: number;
}

/**
 * Restore loop state from checkpoint data. Shared by both rollback paths.
 */
function restoreFromCheckpoint(
  state: LoopMutableState,
  cpData: CheckpointData | null,
  bestParams: Record<string, number> | null,
): LoopMutableState {
  const next = { ...state };

  if (bestParams) {
    next.paramOverrides = bestParams;
  }

  if (cpData?.metrics) {
    next.currentMetrics = cpData.metrics as Metrics;
    next.currentAnalysis = cpData.analysis ?? null;
    if (next.currentAnalysis) next.lastAnalysis = next.currentAnalysis;
    next.currentPnl = next.currentMetrics.totalPnl ?? 0;
  }

  if (cpData?.paramCount != null) {
    next.paramCount = cpData.paramCount;
  } else if (cpData?.params) {
    next.paramCount = Object.keys(cpData.params).length;
  }

  if (cpData?.strategyParams) {
    next.lastStrategyParams = cpData.strategyParams;
  }

  return next;
}

/**
 * Rollback C: score degraded / neutral / guardrail rejected.
 * Pure function — all I/O (checkpoint.rollback, actor.send, emitEvent, logging)
 * stays in the orchestrator.
 */
export function applyRollback(
  state: LoopMutableState,
  cpData: CheckpointData | null,
  bestParams: Record<string, number> | null,
  ctx: RollbackContext,
): LoopMutableState {
  const next = restoreFromCheckpoint(state, cpData, bestParams);

  // Track failed restructure for prompt feedback (only non-refine)
  if (ctx.phase !== "refine") {
    const diagParts: string[] = [];
    const diagTrades = ctx.metrics.numTrades ?? 0;
    if (diagTrades < ctx.minTrades) diagParts.push(`trades ${diagTrades} < minTrades ${ctx.minTrades}`);
    if ((ctx.metrics.profitFactor ?? 0) < ctx.minPF) diagParts.push(`PF ${(ctx.metrics.profitFactor ?? 0).toFixed(2)} < ${ctx.minPF}`);
    if (Math.abs(ctx.metrics.maxDrawdownPct ?? 0) > ctx.maxDD) diagParts.push(`DD ${Math.abs(ctx.metrics.maxDrawdownPct ?? 0).toFixed(1)}% > ${ctx.maxDD}%`);
    if (ctx.minWR != null && (ctx.metrics.winRate ?? 0) < ctx.minWR) diagParts.push(`WR ${(ctx.metrics.winRate ?? 0).toFixed(1)}% < ${ctx.minWR}%`);
    if (ctx.wfViolations.length > 0) diagParts.push("WF overfit");
    if (ctx.fvViolations.length > 0) diagParts.push(`free vars ${ctx.paramCount} > ${ctx.maxFreeVariables}`);
    const diagnosis = diagParts.length > 0 ? diagParts.join(", ") : "score degraded";

    // Clone array to avoid mutating input
    next.failedRestructures = [
      ...state.failedRestructures,
      {
        globalIter: ctx.globalIter,
        trades: diagTrades,
        pf: ctx.metrics.profitFactor ?? 0,
        score: ctx.scoreWeighted,
        diagnosis,
      },
    ];
  }

  // Build rollback reason
  const isNeutralDrift = ctx.effectiveVerdict !== "reject";
  let rollbackCause: string;
  if (isNeutralDrift) {
    rollbackCause = `neutral — score ${ctx.scoreWeighted.toFixed(1)} within noise band of best ${ctx.bestScore.toFixed(1)}`;
  } else if (ctx.effectiveVerdict === ctx.scoreVerdict) {
    rollbackCause = `score degraded (${ctx.scoreWeighted.toFixed(1)} vs best ${ctx.bestScore.toFixed(1)})`;
  } else if (ctx.wfViolations.length > 0) {
    const wfData = ctx.analysis?.walkForward;
    rollbackCause = `WF overfit: pfRatio=${wfData?.pfRatio?.toFixed(2) ?? "?"} < 0.6 (train PF=${wfData?.trainPF?.toFixed(2) ?? "?"}, test PF=${wfData?.testPF?.toFixed(2) ?? "?"})`;
  } else if (ctx.fvViolations.length > 0) {
    rollbackCause = `Free variable cap exceeded: ${ctx.paramCount} params > max ${ctx.maxFreeVariables}`;
  } else {
    rollbackCause = `guardrail rejected`;
  }
  next.lastRollbackReason = `Iteration ${ctx.iter} rolled back: ${rollbackCause}`;

  return next;
}

/**
 * Rollback B2: score > best but trades < minTrades (non-refine only).
 * Pure function — I/O stays in orchestrator.
 */
export function applyB2Rollback(
  state: LoopMutableState,
  cpData: CheckpointData | null,
  bestParams: Record<string, number> | null,
): LoopMutableState {
  return restoreFromCheckpoint(state, cpData, bestParams);
}
