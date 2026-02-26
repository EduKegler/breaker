import { describe, it, expect } from "vitest";
import { buildSessionSummary } from "./summary.js";
import type { IterationMetric } from "../types.js";

const sampleMetrics: IterationMetric[] = [
  { iter: 1, pnl: 200, pf: 1.4, dd: 5.5, wr: 22, trades: 180, verdict: "neutral" },
  { iter: 2, pnl: 230, pf: 1.5, dd: 5.0, wr: 24, trades: 175, verdict: "improved" },
  { iter: 3, pnl: 180, pf: 1.3, dd: 7.0, wr: 20, trades: 190, verdict: "degraded" },
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
});
