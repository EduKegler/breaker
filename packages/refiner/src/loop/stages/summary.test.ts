import { describe, it, expect } from "vitest";
import { buildSessionSummary, buildConsoleSummary } from "./summary.js";
import type { IterationMetric } from "../types.js";

const sampleMetrics: IterationMetric[] = [
  { iter: 1, pnl: 200, pf: 1.4, dd: 5.5, wr: 22, trades: 180, verdict: "neutral", durationMs: 45000, summary: "tpRR 2→1.5" },
  { iter: 2, pnl: 230, pf: 1.5, dd: 5.0, wr: 24, trades: 175, verdict: "improved", durationMs: 120000, summary: "volMult 1.5→2.0" },
  { iter: 3, pnl: 180, pf: 1.3, dd: 7.0, wr: 20, trades: 190, verdict: "degraded", durationMs: 62000 },
];

describe("buildSessionSummary", () => {
  it("includes asset and run id", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "20260222_120000",
      metrics: sampleMetrics,
      durationMs: 125000,
      success: true,
      bestIter: 2,
      bestPnl: 230,
    });
    expect(msg).toContain("BTC");
    expect(msg).toContain("20260222_120000");
  });

  it("shows success status when criteria passed", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r1",
      metrics: sampleMetrics,
      durationMs: 60000,
      success: true,
      bestIter: 2,
      bestPnl: 230,
    });
    expect(msg).toContain("CRITERIA PASSED");
    expect(msg).toContain("\u{2705}");
  });

  it("shows failure status when max iter reached", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r1",
      metrics: sampleMetrics,
      durationMs: 60000,
      success: false,
      bestIter: 2,
      bestPnl: 230,
    });
    expect(msg).toContain("MAX ITER REACHED");
  });

  it("shows evolution with arrows", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r1",
      metrics: sampleMetrics,
      durationMs: 60000,
      success: false,
      bestIter: 2,
      bestPnl: 230,
    });
    expect(msg).toContain("iter1");
    expect(msg).toContain("iter2");
    expect(msg).toContain("iter3");
  });

  it("shows best iteration info", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r1",
      metrics: sampleMetrics,
      durationMs: 300000,
      success: true,
      bestIter: 2,
      bestPnl: 230,
    });
    expect(msg).toContain("Best iter:* 2");
    expect(msg).toContain("$230.00");
  });

  it("formats duration correctly", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r1",
      metrics: [],
      durationMs: 125000,
      success: false,
      bestIter: 0,
      bestPnl: 0,
    });
    expect(msg).toContain("2m 5s");
  });

  it("includes strategy in header when provided", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      strategy: "breakout",
      runId: "r1",
      metrics: [],
      durationMs: 5000,
      success: false,
      bestIter: 0,
      bestPnl: 0,
    });
    expect(msg).toContain("BTC/breakout");
  });

  it("handles empty metrics gracefully", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r1",
      metrics: [],
      durationMs: 5000,
      success: false,
      bestIter: 0,
      bestPnl: 0,
    });
    expect(msg).toContain("BTC");
    expect(msg).not.toContain("Last iter:");
  });

  it("formats long duration (hours) correctly", () => {
    const msg = buildSessionSummary({
      asset: "ETH",
      runId: "r2",
      metrics: sampleMetrics,
      durationMs: 7325000, // 2h 2m 5s = 122m 5s
      success: false,
      bestIter: 1,
      bestPnl: 200,
    });
    expect(msg).toContain("122m 5s");
  });

  it("handles single metric in evolution", () => {
    const single: IterationMetric[] = [
      { iter: 1, pnl: 150, pf: 1.2, dd: 8.0, wr: 18, trades: 160, verdict: "neutral" },
    ];
    const msg = buildSessionSummary({
      asset: "SOL",
      runId: "r3",
      metrics: single,
      durationMs: 30000,
      success: false,
      bestIter: 1,
      bestPnl: 150,
    });
    expect(msg).toContain("iter1");
    expect(msg).toContain("$150.00");
    expect(msg).toContain("Last iter:");
  });

  it("shows iteration duration and summary in evolution", () => {
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r1",
      metrics: sampleMetrics,
      durationMs: 60000,
      success: false,
      bestIter: 2,
      bestPnl: 230,
    });
    // iter 1: 45s, has summary
    expect(msg).toContain("45s");
    expect(msg).toContain("tpRR 2→1.5");
    // iter 2: 2m 0s, has summary
    expect(msg).toContain("2m");
    expect(msg).toContain("volMult 1.5→2.0");
    // iter 3: 1m 2s, no summary
    expect(msg).toContain("1m 2s");
  });

  it("displays DD without negative sign in evolution and last iter (P1: display fix)", () => {
    const negDD: IterationMetric[] = [
      { iter: 1, pnl: -442, pf: 0.33, dd: -44.3, wr: 38, trades: 157, verdict: "neutral" },
    ];
    const msg = buildSessionSummary({
      asset: "BTC",
      runId: "r4",
      metrics: negDD,
      durationMs: 10000,
      success: false,
      bestIter: 1,
      bestPnl: -442,
    });
    expect(msg).toContain("DD=44.3%");
    expect(msg).not.toContain("DD=-44.3%");
    // Last iter section
    expect(msg).toContain("DD: 44.3%");
    expect(msg).not.toContain("DD: -44.3%");
  });
});

// ---------------------------------------------------------------------------
// buildConsoleSummary
// ---------------------------------------------------------------------------

const consoleBaseOpts = {
  asset: "BTC",
  strategy: "breakout",
  runId: "20260306_181252",
  metrics: sampleMetrics,
  durationMs: 125000,
  success: false,
  bestIter: 2,
  bestPnl: 230,
  bestScore: 64.5,
};

describe("buildConsoleSummary", () => {
  it("includes header with asset and status", () => {
    const msg = buildConsoleSummary(consoleBaseOpts);
    expect(msg).toContain("B.R.E.A.K.E.R.");
    expect(msg).toContain("BTC/breakout");
    expect(msg).toContain("MAX ITER REACHED");
  });

  it("highlights best iteration in green and worst in red", () => {
    const msg = buildConsoleSummary(consoleBaseOpts);
    // iter 2 (best PnL=230) should have green ANSI
    expect(msg).toContain("\x1b[32m");
    // iter 3 (worst PnL=180) should have red ANSI
    expect(msg).toContain("\x1b[31m");
  });

  it("shows all iterations with metrics", () => {
    const msg = buildConsoleSummary(consoleBaseOpts);
    expect(msg).toContain("200.00");
    expect(msg).toContain("230.00");
    expect(msg).toContain("180.00");
    expect(msg).toContain("PF");
    expect(msg).toContain("WR");
  });

  it("shows summary on separate line", () => {
    const msg = buildConsoleSummary(consoleBaseOpts);
    expect(msg).toContain("tpRR 2→1.5");
    expect(msg).toContain("volMult 1.5→2.0");
  });

  it("handles empty metrics", () => {
    const msg = buildConsoleSummary({ ...consoleBaseOpts, metrics: [] });
    expect(msg).toContain("B.R.E.A.K.E.R.");
    expect(msg).not.toContain("iter 1");
  });

  it("shows best score in header", () => {
    const msg = buildConsoleSummary(consoleBaseOpts);
    expect(msg).toContain("64.5");
  });

  it("shows verdict arrows", () => {
    const msg = buildConsoleSummary(consoleBaseOpts);
    expect(msg).toContain("▲"); // improved
    expect(msg).toContain("▼"); // degraded
  });
});
