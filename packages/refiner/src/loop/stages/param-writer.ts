import fs from "node:fs";
import writeFileAtomic from "write-file-atomic";
import type {
  ParameterHistory,
  ParameterHistoryIteration,
  NeverWorkedEntry,
  PendingHypothesis,
  ApproachRecord,
  TestedCombination,
} from "../../types/parameter-history.js";
import type { LoopPhase } from "../types.js";
import { safeJsonParse } from "../../lib/safe-json.js";
import { paramHistorySchema } from "../../lib/param-history-schema.js";

export interface IterationMetadata {
  changeApplied: {
    param: string;
    from: unknown;
    to: unknown;
    scale: "parametric" | "structural";
    description: string;
  } | null;
  hypotheses: { rank: number; hypothesis: string; confidence: string; applied: boolean }[];
  diagnostic: {
    type: "parametric" | "structural";
    rootCause: string;
    phaseRecommendation: LoopPhase | null;
  };
  expectedResult: { metric: string; direction: string; estimate: string };
  nextSteps: { condition: string; action: string }[];
  /** Components selected from KB catalog during restructure (slot name → candidate name) */
  selectedComponents?: Record<string, string>;
}

function emptyHistory(): ParameterHistory {
  return {
    iterations: [],
    neverWorked: [],
    exploredRanges: {},
    pendingHypotheses: [],
    approaches: [],
    researchLog: [],
    testedCombinations: [],
  };
}


function isAlreadyInNeverWorked(
  neverWorked: (string | NeverWorkedEntry)[],
  entry: NeverWorkedEntry,
): boolean {
  return neverWorked.some((item) => {
    if (typeof item === "string") return false;
    return item.param === entry.param && JSON.stringify(item.value) === JSON.stringify(entry.value);
  });
}

/**
 * Parameter history operations for the optimization loop.
 * Consolidated into a single object to comply with one-export-per-file.
 */
export const paramWriter = {
  /**
   * Load parameter history from disk, or return empty if not found.
   */
  loadHistory(filePath: string): ParameterHistory {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return safeJsonParse(raw, { schema: paramHistorySchema }) as unknown as ParameterHistory;
    } catch {
      return emptyHistory();
    }
  },

  /**
   * Backfill the `after` field of the last pending iteration in parameter-history.
   * Called EARLY in the loop -- before any `continue` paths -- so that failed/rolled-back
   * iterations always get their results recorded. Also updates neverWorked for degraded changes.
   *
   * This is idempotent: if the last iteration already has `after` filled, it's a no-op.
   */
  backfillLastIteration(opts: {
    historyPath: string;
    currentMetrics: { pnl: number; trades: number; pf: number };
    verdictOverride?: { verdict: string; note: string };
  }): ParameterHistory {
    const { historyPath, currentMetrics, verdictOverride } = opts;
    const history = paramWriter.loadHistory(historyPath);

    if (history.iterations.length === 0) return history;

    const last = history.iterations[history.iterations.length - 1];
    if (last.after !== null) return history; // already filled

    // Fill after + verdict
    last.after = { pnl: currentMetrics.pnl, trades: currentMetrics.trades, pf: currentMetrics.pf };
    if (verdictOverride) {
      last.verdict = verdictOverride.verdict as ParameterHistoryIteration["verdict"];
      last.note = verdictOverride.note;
    } else if (last.before) {
      const oldPnl = last.before.pnl;
      const changePct = oldPnl !== 0
        ? (currentMetrics.pnl - oldPnl) / Math.abs(oldPnl)
        : (currentMetrics.pnl > oldPnl ? 1 : currentMetrics.pnl < oldPnl ? -1 : 0);
      if (changePct > 0.05) last.verdict = "improved";
      else if (changePct < -0.05) last.verdict = "degraded";
      else last.verdict = "neutral";
    }

    // Update neverWorked for degraded/neutral changes
    if (last.change && last.verdict !== "pending") {
      const tradeDelta = last.after && last.before
        ? last.after.trades - last.before.trades
        : 0;
      const pnlDelta = last.after && last.before
        ? Math.abs((last.after.pnl - last.before.pnl) / Math.abs(last.before.pnl || 1))
        : 0;

      if (last.verdict === "neutral" && Math.abs(tradeDelta) <= 1) {
        const entry: NeverWorkedEntry = {
          param: last.change.param,
          value: last.change.to,
          iter: last.iter,
          reason: "no_trade_impact",
        };
        if (!isAlreadyInNeverWorked(history.neverWorked, entry)) {
          history.neverWorked.push(entry);
        }
      } else if (last.verdict === "degraded" && pnlDelta > 0.15) {
        const entry: NeverWorkedEntry = {
          param: last.change.param,
          value: last.change.to,
          iter: last.iter,
          reason: "pnl_degraded",
        };
        if (!isAlreadyInNeverWorked(history.neverWorked, entry)) {
          history.neverWorked.push(entry);
        }
      }
    }

    // Write atomically
    writeFileAtomic.sync(historyPath, JSON.stringify(history, null, 2), "utf8");

    return history;
  },

  /**
   * Deterministically update parameter-history.json from Claude's metadata.
   * This replaces the old approach of letting Claude edit the file directly.
   */
  updateHistory(opts: {
    historyPath: string;
    metadata: IterationMetadata;
    globalIter: number;
    currentMetrics: { pnl: number; trades: number; pf: number };
    score?: number;
    phase?: LoopPhase;
  }): ParameterHistory {
    const { historyPath, metadata, globalIter, currentMetrics, score, phase } = opts;
    const history = paramWriter.loadHistory(historyPath);

    // 1. Complete `after` of previous iteration
    if (history.iterations.length > 0) {
      const prev = history.iterations[history.iterations.length - 1];
      if (prev.after === null) {
        prev.after = { pnl: currentMetrics.pnl, trades: currentMetrics.trades, pf: currentMetrics.pf };

        // Determine verdict
        if (prev.before) {
          const oldPnl = prev.before.pnl;
          const changePct = oldPnl !== 0
            ? (currentMetrics.pnl - oldPnl) / Math.abs(oldPnl)
            : (currentMetrics.pnl > oldPnl ? 1 : currentMetrics.pnl < oldPnl ? -1 : 0);
          if (changePct > 0.05) prev.verdict = "improved";
          else if (changePct < -0.05) prev.verdict = "degraded";
          else prev.verdict = "neutral";
        }
      }
    }

    // 2. Add new iteration
    const change = metadata.changeApplied
      ? { param: metadata.changeApplied.param, from: metadata.changeApplied.from, to: metadata.changeApplied.to }
      : null;

    const newIter: ParameterHistoryIteration = {
      iter: globalIter,
      date: new Date().toISOString().slice(0, 10),
      change,
      before: { pnl: currentMetrics.pnl, trades: currentMetrics.trades, pf: currentMetrics.pf },
      after: null,
      verdict: "pending",
      note: metadata.changeApplied?.description,
    };
    history.iterations.push(newIter);

    // 3. Update exploredRanges
    if (metadata.changeApplied) {
      const param = metadata.changeApplied.param;
      if (!history.exploredRanges[param]) {
        history.exploredRanges[param] = [];
      }
      const values = history.exploredRanges[param];
      const newVal = metadata.changeApplied.to;
      if (!values.some((v) => JSON.stringify(v) === JSON.stringify(newVal))) {
        values.push(newVal);
      }
    }

    // 4. Handle neverWorked from previous iteration verdict
    const prevIter = history.iterations.length >= 2 ? history.iterations[history.iterations.length - 2] : null;
    if (prevIter && prevIter.verdict !== "pending" && prevIter.change) {
      const tradeDelta = prevIter.after && prevIter.before
        ? prevIter.after.trades - prevIter.before.trades
        : 0;
      const pnlDelta = prevIter.after && prevIter.before
        ? Math.abs((prevIter.after.pnl - prevIter.before.pnl) / Math.abs(prevIter.before.pnl || 1))
        : 0;

      if (prevIter.verdict === "neutral" && Math.abs(tradeDelta) <= 1) {
        const entry: NeverWorkedEntry = {
          param: prevIter.change.param,
          value: prevIter.change.to,
          iter: prevIter.iter,
          reason: "no_trade_impact",
        };
        if (!isAlreadyInNeverWorked(history.neverWorked, entry)) {
          history.neverWorked.push(entry);
        }
      } else if (prevIter.verdict === "degraded" && pnlDelta > 0.15) {
        const entry: NeverWorkedEntry = {
          param: prevIter.change.param,
          value: prevIter.change.to,
          iter: prevIter.iter,
          reason: "pnl_degraded",
        };
        if (!isAlreadyInNeverWorked(history.neverWorked, entry)) {
          history.neverWorked.push(entry);
        }
      }
    }

    // 5. Handle pending hypotheses
    // Expire old ones
    for (const h of history.pendingHypotheses) {
      if (!h.expired && h.iter <= globalIter - 5) {
        h.expired = true;
        h.note = `expired: >5 iters old (current: ${globalIter})`;
      }
    }

    // Add new hypotheses from metadata (rank > 1)
    const hypotheses = Array.isArray(metadata.hypotheses) ? metadata.hypotheses : [];
    for (const hyp of hypotheses) {
      if (hyp.applied) continue; // Already applied
      const existing = history.pendingHypotheses.find(
        (h) => !h.expired && h.hypothesis.slice(0, 30) === hyp.hypothesis.slice(0, 30),
      );
      if (existing) {
        existing.rank = hyp.rank;
        existing.iter = globalIter;
      } else {
        history.pendingHypotheses.push({
          iter: globalIter,
          rank: hyp.rank,
          hypothesis: hyp.hypothesis,
          expired: false,
        });
      }
    }

    // 6. Update phase tracking
    if (phase) {
      history.currentPhase = phase;
      if (!history.phaseStartIter) {
        history.phaseStartIter = globalIter;
      }
    }

    // 7. Write atomically
    writeFileAtomic.sync(historyPath, JSON.stringify(history, null, 2), "utf8");

    return history;
  },

  /**
   * Mark the current approach as exhausted and create a new one.
   */
  transitionApproach(opts: {
    historyPath: string;
    newApproach: { name: string; indicators: string[] };
    globalIter: number;
    reason: string;
  }): void {
    const { historyPath, newApproach, globalIter, reason } = opts;
    const history = paramWriter.loadHistory(historyPath);

    if (!history.approaches) history.approaches = [];

    // Mark current active approach as exhausted
    const active = history.approaches.find((a) => a.verdict === "active");
    if (active) {
      active.verdict = "exhausted";
      active.endIter = globalIter;
      active.reason = reason;
    }

    // Add new approach
    const nextId = history.approaches.length > 0
      ? Math.max(...history.approaches.map((a) => a.id)) + 1
      : 1;

    history.approaches.push({
      id: nextId,
      name: newApproach.name,
      indicators: newApproach.indicators,
      startIter: globalIter,
      endIter: globalIter,
      bestScore: 0,
      bestMetrics: { pnl: 0, pf: 0, wr: 0 },
      verdict: "active",
    });

    writeFileAtomic.sync(historyPath, JSON.stringify(history, null, 2), "utf8");
  },

  /**
   * Record a tested component combination from a restructure iteration.
   * Called after a restructure produces metadata with `selectedComponents`.
   */
  recordTestedCombination(opts: {
    historyPath: string;
    globalIter: number;
    components: Record<string, string>;
    metrics: { pnl: number; pf: number; wr: number; dd: number; trades: number } | null;
  }): void {
    const { historyPath, globalIter, components, metrics } = opts;
    const history = paramWriter.loadHistory(historyPath);

    if (!history.testedCombinations) history.testedCombinations = [];

    history.testedCombinations.push({
      iter: globalIter,
      components,
      bestMetrics: metrics,
    });

    writeFileAtomic.sync(historyPath, JSON.stringify(history, null, 2), "utf8");
  },
};
