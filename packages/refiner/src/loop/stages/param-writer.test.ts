import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { paramWriter } from "./param-writer.js";
import type { IterationMetadata } from "./param-writer.js";

let tmpDir: string;
let historyPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "param-writer-test-"));
  historyPath = path.join(tmpDir, "parameter-history.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const baseMetadata: IterationMetadata = {
  changeApplied: { param: "atrMult", from: 4.0, to: 4.5, scale: "parametric", description: "test change" },
  hypotheses: [
    { rank: 1, hypothesis: "Increase ATR mult to reduce SL", confidence: "Alta", applied: true },
    { rank: 2, hypothesis: "Try RSI filter", confidence: "Media", applied: false },
  ],
  diagnostic: { type: "parametric", rootCause: "SL too tight", phaseRecommendation: null },
  expectedResult: { metric: "PnL", direction: "up", estimate: "+10%" },
  nextSteps: [{ condition: "PnL < 180", action: "revert atrMult" }],
};

describe("paramWriter.loadHistory", () => {
  it("returns empty structure when file does not exist", () => {
    const h = paramWriter.loadHistory(path.join(tmpDir, "nonexistent.json"));
    expect(h.iterations).toEqual([]);
    expect(h.neverWorked).toEqual([]);
    expect(h.exploredRanges).toEqual({});
  });
});

describe("paramWriter.updateHistory", () => {
  it("creates new history when file does not exist", () => {
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].iter).toBe(1);
    expect(result.iterations[0].change?.param).toBe("atrMult");
    expect(result.iterations[0].verdict).toBe("pending");
    expect(fs.existsSync(historyPath)).toBe(true);
  });

  it("completes previous iteration after field", () => {
    // Seed with pending iteration
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, changeApplied: { param: "rr1", from: 0.5, to: 0.7, scale: "parametric", description: "tweak TP1" } },
      globalIter: 2,
      currentMetrics: { pnl: 230, trades: 182, pf: 1.6 },
    });

    expect(result.iterations).toHaveLength(2);
    expect(result.iterations[0].after).toEqual({ pnl: 230, trades: 182, pf: 1.6 });
    expect(result.iterations[0].verdict).toBe("improved");
  });

  it("adds to exploredRanges", () => {
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });
    expect(result.exploredRanges.atrMult).toContain(4.5);
  });

  it("does not duplicate exploredRanges values", () => {
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 2,
      currentMetrics: { pnl: 210, trades: 181, pf: 1.5 },
    });
    expect(result.exploredRanges.atrMult!.filter((v) => v === 4.5)).toHaveLength(1);
  });

  it("adds pending hypotheses for non-applied", () => {
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });
    expect(result.pendingHypotheses).toHaveLength(1);
    expect(result.pendingHypotheses[0].hypothesis).toContain("RSI");
  });

  it("expires old pending hypotheses", () => {
    // Create old hypothesis
    const history = paramWriter.loadHistory(historyPath);
    history.pendingHypotheses.push({
      iter: 1,
      rank: 2,
      hypothesis: "Old hypothesis",
      expired: false,
    });
    fs.writeFileSync(historyPath, JSON.stringify(history));

    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, hypotheses: [] },
      globalIter: 7, // 7 - 5 = 2 > 1
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });
    expect(result.pendingHypotheses[0].expired).toBe(true);
  });

  it("detects neverWorked for no_trade_impact", () => {
    // Iter 1: set up with change, then complete with neutral + no trade delta
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    // Iter 2: metrics identical -> prev iter gets neutral verdict + 0 trade delta
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, changeApplied: { param: "rr2", from: 4.0, to: 3.0, scale: "parametric", description: "test" } },
      globalIter: 2,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    const nwEntries = result.neverWorked.filter((e) => typeof e !== "string" && e.reason === "no_trade_impact");
    expect(nwEntries.length).toBe(1);
  });

  it("writes atomically via write-file-atomic", () => {
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });
    // File should be valid JSON
    const parsed = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    expect(parsed.iterations).toHaveLength(1);
  });

  it("detects neverWorked for pnl_degraded", () => {
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    // Iter 2: PnL drops >15% -> prev iter gets degraded verdict
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, changeApplied: { param: "rr2", from: 4.0, to: 3.0, scale: "parametric", description: "test" } },
      globalIter: 2,
      currentMetrics: { pnl: 150, trades: 180, pf: 1.2 },
    });

    const nwEntries = result.neverWorked.filter((e) => typeof e !== "string" && e.reason === "pnl_degraded");
    expect(nwEntries.length).toBe(1);
  });

  it("does not duplicate neverWorked entries", () => {
    // Seed with existing neverWorked entry
    const history = paramWriter.loadHistory(historyPath);
    history.iterations = [
      { iter: 1, date: "2026-01-01", change: { param: "atrMult", from: 4, to: 4.5 }, before: { pnl: 200, trades: 180, pf: 1.5 }, after: null, verdict: "pending" },
    ];
    history.neverWorked = [{ param: "atrMult", value: 4.5, iter: 1, reason: "no_trade_impact" }];
    fs.writeFileSync(historyPath, JSON.stringify(history));

    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, changeApplied: { param: "rr1", from: 0.5, to: 0.7, scale: "parametric", description: "test" } },
      globalIter: 2,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    // Should not duplicate the existing entry
    const atrEntries = result.neverWorked.filter((e) => typeof e !== "string" && e.param === "atrMult");
    expect(atrEntries.length).toBe(1);
  });

  it("handles null changeApplied (no-op iteration)", () => {
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, changeApplied: null },
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    expect(result.iterations[0].change).toBeNull();
    expect(Object.keys(result.exploredRanges)).toHaveLength(0);
  });

  it("updates existing pending hypothesis instead of duplicating", () => {
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    // Same hypothesis text (first 30 chars match exactly) at a later iter
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: {
        ...baseMetadata,
        hypotheses: [
          { rank: 1, hypothesis: "Increase ATR mult to reduce SL", confidence: "Alta", applied: true },
          { rank: 3, hypothesis: "Try RSI filter", confidence: "Alta", applied: false },
        ],
      },
      globalIter: 2,
      currentMetrics: { pnl: 210, trades: 181, pf: 1.55 },
    });

    // "Try RSI filter" matches first 30 chars -> updated, not duplicated
    const rsiHyps = result.pendingHypotheses.filter((h) => h.hypothesis.startsWith("Try RSI"));
    expect(rsiHyps.length).toBe(1);
    expect(rsiHyps[0].rank).toBe(3);
    expect(rsiHyps[0].iter).toBe(2);
  });

  it("tracks phase in history", () => {
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
      phase: "research",
    });

    expect(result.currentPhase).toBe("research");
    expect(result.phaseStartIter).toBe(1);
  });

  it("does not overwrite phaseStartIter on subsequent calls", () => {
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
      phase: "refine",
    });

    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, changeApplied: null },
      globalIter: 2,
      currentMetrics: { pnl: 210, trades: 182, pf: 1.55 },
      phase: "refine",
    });

    expect(result.phaseStartIter).toBe(1);
  });

  it("handles non-array hypotheses without crashing", () => {
    const metadataWithBadHypotheses = {
      ...baseMetadata,
      hypotheses: "not an array" as unknown as IterationMetadata["hypotheses"],
    };
    const result = paramWriter.updateHistory({
      historyPath,
      metadata: metadataWithBadHypotheses,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });
    expect(result.iterations).toHaveLength(1);
    expect(result.pendingHypotheses).toEqual([]);
  });

  it("sets degraded verdict when PnL drops >5%", () => {
    paramWriter.updateHistory({
      historyPath,
      metadata: baseMetadata,
      globalIter: 1,
      currentMetrics: { pnl: 200, trades: 180, pf: 1.5 },
    });

    const result = paramWriter.updateHistory({
      historyPath,
      metadata: { ...baseMetadata, changeApplied: null },
      globalIter: 2,
      currentMetrics: { pnl: 180, trades: 180, pf: 1.3 },
    });

    expect(result.iterations[0].verdict).toBe("degraded");
  });
});

describe("paramWriter.backfillLastIteration", () => {
  it("fills after/verdict on the last pending iteration", () => {
    // Seed: iter 1 proposed atrStopMult 2.0->2.5, after=null
    const history = paramWriter.loadHistory(historyPath);
    history.iterations = [{
      iter: 1, date: "2026-01-01",
      change: { param: "atrStopMult", from: 2.0, to: 2.5 },
      before: { pnl: -28, trades: 127, pf: 0.686 },
      after: null, verdict: "pending",
    }];
    history.exploredRanges = { atrStopMult: [2.5] };
    fs.writeFileSync(historyPath, JSON.stringify(history));

    const result = paramWriter.backfillLastIteration({
      historyPath,
      currentMetrics: { pnl: -80, trades: 110, pf: 0.5 },
    });

    expect(result.iterations[0].after).toEqual({ pnl: -80, trades: 110, pf: 0.5 });
    expect(result.iterations[0].verdict).toBe("degraded");
  });

  it("adds to neverWorked when degraded >15%", () => {
    const history = paramWriter.loadHistory(historyPath);
    history.iterations = [{
      iter: 1, date: "2026-01-01",
      change: { param: "atrStopMult", from: 2.0, to: 2.5 },
      before: { pnl: 100, trades: 127, pf: 1.2 },
      after: null, verdict: "pending",
    }];
    fs.writeFileSync(historyPath, JSON.stringify(history));

    const result = paramWriter.backfillLastIteration({
      historyPath,
      currentMetrics: { pnl: 50, trades: 120, pf: 0.8 },
    });

    expect(result.iterations[0].verdict).toBe("degraded");
    const nw = result.neverWorked.filter((e) => typeof e !== "string" && e.param === "atrStopMult");
    expect(nw.length).toBe(1);
  });

  it("no-ops when last iteration already has after filled", () => {
    const history = paramWriter.loadHistory(historyPath);
    history.iterations = [{
      iter: 1, date: "2026-01-01",
      change: { param: "dcSlow", from: 40, to: 45 },
      before: { pnl: 100, trades: 130, pf: 1.2 },
      after: { pnl: 120, trades: 135, pf: 1.3 },
      verdict: "improved",
    }];
    fs.writeFileSync(historyPath, JSON.stringify(history));

    const result = paramWriter.backfillLastIteration({
      historyPath,
      currentMetrics: { pnl: 80, trades: 125, pf: 1.0 },
    });

    // Should NOT overwrite the existing after
    expect(result.iterations[0].after).toEqual({ pnl: 120, trades: 135, pf: 1.3 });
    expect(result.iterations[0].verdict).toBe("improved");
  });

  it("no-ops when history is empty", () => {
    const result = paramWriter.backfillLastIteration({
      historyPath,
      currentMetrics: { pnl: 100, trades: 130, pf: 1.2 },
    });
    expect(result.iterations).toHaveLength(0);
  });

  it("persists to disk", () => {
    const history = paramWriter.loadHistory(historyPath);
    history.iterations = [{
      iter: 1, date: "2026-01-01",
      change: { param: "dcFast", from: 15, to: 20 },
      before: { pnl: 100, trades: 130, pf: 1.2 },
      after: null, verdict: "pending",
    }];
    fs.writeFileSync(historyPath, JSON.stringify(history));

    paramWriter.backfillLastIteration({
      historyPath,
      currentMetrics: { pnl: 100, trades: 130, pf: 1.2 },
    });

    // Re-read from disk
    const fromDisk = paramWriter.loadHistory(historyPath);
    expect(fromDisk.iterations[0].after).toEqual({ pnl: 100, trades: 130, pf: 1.2 });
    expect(fromDisk.iterations[0].verdict).toBe("neutral");
  });
});

describe("paramWriter.transitionApproach", () => {
  it("marks active approach as exhausted and adds new one", () => {
    // Seed with active approach
    const history = paramWriter.loadHistory(historyPath);
    history.approaches = [{
      id: 1, name: "ATR Breakout", indicators: ["ATR"], startIter: 1, endIter: 5,
      bestScore: 50, bestMetrics: { pnl: 200, pf: 1.5, wr: 22 }, verdict: "active",
    }];
    fs.writeFileSync(historyPath, JSON.stringify(history));

    paramWriter.transitionApproach({
      historyPath,
      newApproach: { name: "RSI Mean Reversion", indicators: ["RSI", "BB"] },
      globalIter: 6,
      reason: "3 neutral iters, escalating",
    });

    const updated = paramWriter.loadHistory(historyPath);
    expect(updated.approaches![0].verdict).toBe("exhausted");
    expect(updated.approaches![1].name).toBe("RSI Mean Reversion");
    expect(updated.approaches![1].verdict).toBe("active");
    expect(updated.approaches![1].id).toBe(2);
  });

  it("creates first approach when no approaches exist", () => {
    paramWriter.transitionApproach({
      historyPath,
      newApproach: { name: "SMA Crossover", indicators: ["SMA"] },
      globalIter: 1,
      reason: "initial approach",
    });

    const updated = paramWriter.loadHistory(historyPath);
    expect(updated.approaches).toHaveLength(1);
    expect(updated.approaches![0].id).toBe(1);
    expect(updated.approaches![0].verdict).toBe("active");
  });

  it("handles missing approaches array", () => {
    fs.writeFileSync(historyPath, JSON.stringify({ iterations: [], neverWorked: [], exploredRanges: {}, pendingHypotheses: [] }));

    paramWriter.transitionApproach({
      historyPath,
      newApproach: { name: "RSI Strat", indicators: ["RSI"] },
      globalIter: 1,
      reason: "first try",
    });

    const updated = paramWriter.loadHistory(historyPath);
    expect(updated.approaches).toHaveLength(1);
  });
});
