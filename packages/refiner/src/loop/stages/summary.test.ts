import { describe, it, expect } from "vitest";
import { buildSessionSummary, buildConsoleSummary } from "./summary.js";
import type { VariantSummaryInfo, SummaryOpts } from "./summary.js";
import type { IterationMetric } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const v1: VariantSummaryInfo = {
  id: "range-consolidation-partial-tp",
  status: "plateaued",
  bestScore: 67.9,
  bestPnl: 22.76,
  iterationsUsed: 2,
  plateauReason: "noChange",
};

const v2: VariantSummaryInfo = {
  id: "long-range-retest-ema-macd-partial-tp",
  status: "killed",
  bestScore: 0,
  bestPnl: -5.2,
  iterationsUsed: 0,
  killReason: "PF 0.18",
};

const v3: VariantSummaryInfo = {
  id: "range-retest-ema-macd-timeout",
  status: "active",
  bestScore: 87.6,
  bestPnl: 85.87,
  iterationsUsed: 3,
};

const metricsFixture: IterationMetric[] = [
  { iter: 1, variantId: "range-consolidation-partial-tp", pnl: 22.76, pf: 1.52, wr: 73, dd: 2.6, avgR: 0.55, trades: 41, verdict: "improved", durationMs: 80000 },
  { iter: 2, variantId: "range-consolidation-partial-tp", pnl: 18.33, pf: 1.44, wr: 71, dd: 3.1, avgR: 0.48, trades: 38, verdict: "degraded", durationMs: 105000 },
  { iter: 35, variantId: "range-retest-ema-macd-timeout", pnl: 60.74, pf: 1.30, wr: 44, dd: 5.1, avgR: 0.11, trades: 58, verdict: "improved", durationMs: 150000 },
  { iter: 42, variantId: "range-retest-ema-macd-timeout", pnl: 85.87, pf: 1.36, wr: 45, dd: 4.9, avgR: 0.13, trades: 60, verdict: "improved", durationMs: 162000 },
  { iter: 48, variantId: "range-retest-ema-macd-timeout", pnl: 70.11, pf: 1.28, wr: 43, dd: 5.5, avgR: 0.10, trades: 55, verdict: "degraded", durationMs: 140000 },
];

const baseOpts: SummaryOpts = {
  asset: "BTC",
  strategy: "breakout",
  runId: "20260310_120000",
  metrics: metricsFixture,
  variants: [v1, v2, v3],
  durationMs: 8439000, // 140m 39s
  totalIters: 50,
  globalBestVariantId: "range-retest-ema-macd-timeout",
  globalBestScore: 87.6,
  globalBestPnl: 85.87,
  globalBestIter: 42,
  success: false,
};

// ---------------------------------------------------------------------------
// buildSessionSummary (WhatsApp)
// ---------------------------------------------------------------------------

describe("buildSessionSummary", () => {
  it("shows global best in header, not last variant best", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("BEST: range-retest-ema-macd-timeout");
    expect(msg).toContain("score 87.6");
    expect(msg).toContain("PnL $85.87");
  });

  it("includes variant count and total iters in header", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("50 iters");
    expect(msg).toContain("3 variants");
  });

  it("groups metrics by variant with separator", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("range-consolidation-partial-tp (2 iters)");
    expect(msg).toContain("range-retest-ema-macd-timeout (3 iters)");
  });

  it("shows killed variant as one-liner when no metrics", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("long-range-retest-ema-macd-partial-tp -- killed (PF 0.18)");
    // Should NOT show "(0 iters)" for killed with no metrics
    expect(msg).not.toContain("long-range-retest-ema-macd-partial-tp (0 iters)");
  });

  it("shows variant status and score in separators", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("plateaued, score 67.9");
    expect(msg).toContain("active, score 87.6");
  });

  it("includes AvgR in each row", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("AvgR 0.55");
    expect(msg).toContain("AvgR 0.13");
  });

  it("does NOT include Claude summary text", () => {
    const metricsWithSummary = metricsFixture.map(m => ({ ...m, summary: "adjusted TP ratio" }));
    const msg = buildSessionSummary({ ...baseOpts, metrics: metricsWithSummary });
    expect(msg).not.toContain("adjusted TP ratio");
  });

  it("marks global best iter with star emoji", () => {
    const msg = buildSessionSummary(baseOpts);
    // iter 42 is globalBestIter in range-retest-ema-macd-timeout
    expect(msg).toContain("\u{2B50} ");
    // Only one star
    const starCount = (msg.match(/\u{2B50}/gu) ?? []).length;
    expect(starCount).toBe(1);
  });

  it("formats duration correctly", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("140m 39s");
  });

  it("shows success status when criteria passed", () => {
    const msg = buildSessionSummary({ ...baseOpts, success: true });
    expect(msg).toContain("CRITERIA PASSED");
    expect(msg).toContain("\u{2705}");
  });

  it("shows failure status when max iter reached", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("MAX ITER REACHED");
  });

  it("handles empty metrics gracefully", () => {
    const msg = buildSessionSummary({ ...baseOpts, metrics: [], variants: [v3] });
    expect(msg).toContain("B.R.E.A.K.E.R.");
    expect(msg).toContain("BEST:");
  });

  it("handles single variant", () => {
    const single: IterationMetric[] = [
      { iter: 1, variantId: "donchian-ema-timeout", pnl: 50, pf: 1.2, wr: 55, dd: 3.0, avgR: 0.3, trades: 30, verdict: "neutral" },
    ];
    const singleVariant: VariantSummaryInfo = {
      id: "donchian-ema-timeout", status: "active", bestScore: 45.0, bestPnl: 50, iterationsUsed: 1,
    };
    const msg = buildSessionSummary({
      ...baseOpts,
      metrics: single,
      variants: [singleVariant],
      totalIters: 1,
      globalBestVariantId: "donchian-ema-timeout",
      globalBestScore: 45.0,
      globalBestPnl: 50,
      globalBestIter: 1,
    });
    expect(msg).toContain("1 variants");
    expect(msg).toContain("donchian-ema-timeout (1 iters)");
  });

  it("includes asset/strategy label in header", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("BTC/breakout");
  });

  it("displays DD without negative sign", () => {
    const negDD: IterationMetric[] = [
      { iter: 1, variantId: "test-v", pnl: -10, pf: 0.5, wr: 30, dd: -12.5, avgR: -0.1, trades: 20, verdict: "neutral" },
    ];
    const tv: VariantSummaryInfo = { id: "test-v", status: "active", bestScore: 10, bestPnl: -10, iterationsUsed: 1 };
    const msg = buildSessionSummary({
      ...baseOpts, metrics: negDD, variants: [tv],
      globalBestVariantId: "test-v", globalBestIter: 1,
    });
    expect(msg).toContain("DD 12.5%");
    expect(msg).not.toContain("DD -12.5%");
  });

  it("shows run id", () => {
    const msg = buildSessionSummary(baseOpts);
    expect(msg).toContain("20260310_120000");
  });
});

// ---------------------------------------------------------------------------
// buildConsoleSummary (ANSI)
// ---------------------------------------------------------------------------

describe("buildConsoleSummary", () => {
  it("includes header with global best variant and score", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("B.R.E.A.K.E.R.");
    expect(msg).toContain("BTC/breakout");
    expect(msg).toContain("range-retest-ema-macd-timeout");
    expect(msg).toContain("87.6");
  });

  it("shows variant count and iter count in header", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("50 iters");
    expect(msg).toContain("3 variants");
  });

  it("shows variant separators with status", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("range-consolidation-partial-tp (2 iters)");
    expect(msg).toContain("plateaued, score 67.9");
    expect(msg).toContain("active, score 87.6");
  });

  it("highlights global best iter with star", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("⭐ ");
    expect(msg).toContain("iter 42");
  });

  it("includes AvgR in metric rows", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("AvgR 0.55");
    expect(msg).toContain("AvgR 0.13");
  });

  it("shows killed variant as one-liner", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("long-range-retest-ema-macd-partial-tp");
    expect(msg).toContain("killed (PF 0.18)");
  });

  it("uses ANSI colors", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("\x1b[1m"); // bold
    expect(msg).toContain("\x1b[0m"); // reset
  });

  it("handles empty metrics", () => {
    const msg = buildConsoleSummary({ ...baseOpts, metrics: [], variants: [v3] });
    expect(msg).toContain("B.R.E.A.K.E.R.");
    expect(msg).not.toContain("iter ");
  });

  it("shows verdict arrows", () => {
    const msg = buildConsoleSummary(baseOpts);
    expect(msg).toContain("▲"); // improved
    expect(msg).toContain("▼"); // degraded
  });

  it("does NOT include Claude summary text in rows", () => {
    const metricsWithSummary = metricsFixture.map(m => ({ ...m, summary: "some LLM output" }));
    const msg = buildConsoleSummary({ ...baseOpts, metrics: metricsWithSummary });
    expect(msg).not.toContain("some LLM output");
  });
});
