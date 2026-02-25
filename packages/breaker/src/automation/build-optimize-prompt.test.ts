import { describe, it, expect } from "vitest";
import {
  compressLog,
  extractField,
  readFileOrEmpty,
  buildTradeAnalysisSection,
  buildPineParamsSection,
  buildComplexitySection,
  buildOverfitSection,
  buildFilterSimsSection,
  buildExploredSpaceSection,
  buildPendingHypothesesSection,
  buildApproachHistorySection,
  buildDiagnosticInstruction,
  buildCoreParamsSection,
  buildDesignChecklistSection,
} from "./build-optimize-prompt.js";
import type { TradeAnalysis } from "../types/parse-results.js";
import type { ParameterHistory } from "../types/parameter-history.js";

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Fixtures ---

const sampleTradeAnalysis: TradeAnalysis = {
  totalExitRows: 180,
  byDirection: {
    long: { count: 100, pnl: 150, winRate: 25, profitFactor: 1.15, avgTrade: 1.5 },
    short: { count: 80, pnl: 50, winRate: 20, profitFactor: 1.05, avgTrade: 0.63 },
  },
  byExitType: [
    { signal: "TP1", count: 80, pnl: 200, winRate: 55 },
    { signal: "SL", count: 100, pnl: -150, winRate: 0 },
  ],
  avgBarsWinners: 8,
  avgBarsLosers: 3,
  byDayOfWeek: { Mon: { count: 30, pnl: 50 }, Tue: { count: 25, pnl: -10 } },
  bestHoursUTC: [{ hour: 14, count: 20, pnl: 80 }],
  worstHoursUTC: [{ hour: 3, count: 15, pnl: -40 }],
  best3TradesPnl: [25, 20, 18],
  worst3TradesPnl: [-30, -25, -20],
  filterSimulations: {
    totalPnl: 200,
    totalTrades: 180,
    byHour: [
      { hour: 3, tradesRemoved: 15, pnlDelta: 40, pnlAfter: 240, tradesAfter: 165 },
      { hour: 10, tradesRemoved: 10, pnlDelta: -20, pnlAfter: 180, tradesAfter: 170 },
    ],
    byDay: [
      { day: "Tue", tradesRemoved: 25, pnlDelta: 10, pnlAfter: 210, tradesAfter: 155 },
    ],
    removeAllSL: { tradesRemoved: 100, pnlDelta: 150, pnlAfter: 350, tradesAfter: 80 },
  },
  walkForward: null,
  bySession: null,
};

function makeParamHistory(overrides: Partial<ParameterHistory> = {}): ParameterHistory {
  return {
    iterations: [],
    neverWorked: [],
    exploredRanges: {},
    pendingHypotheses: [],
    approaches: [],
    ...overrides,
  };
}

// --- Existing tests ---

describe("extractField", () => {
  it("extracts a field value from markdown", () => {
    const text = `- **Change applied**: changed atrMult from 4.0 to 5.0
- **Expected result**: better PF`;
    expect(extractField(text, "Change applied")).toBe(
      "changed atrMult from 4.0 to 5.0",
    );
  });

  it("returns dash for missing field", () => {
    expect(extractField("nothing here", "Missing")).toBe("—");
  });

  it("truncates long values to 120 chars", () => {
    const longValue = "x".repeat(200);
    const text = `- **Field**: ${longValue}`;
    expect(extractField(text, "Field").length).toBeLessThanOrEqual(120);
  });
});

describe("readFileOrEmpty", () => {
  it("reads file content when file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-test-"));
    try {
      const filePath = path.join(dir, "test.txt");
      fs.writeFileSync(filePath, "hello world");
      expect(readFileOrEmpty(filePath)).toBe("hello world");
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it("returns empty string when file does not exist", () => {
    expect(readFileOrEmpty("/nonexistent/path/to/file.txt")).toBe("");
  });
});

describe("compressLog", () => {
  it("returns original log with no iterations", () => {
    const log = "# Header\nSome content";
    expect(compressLog(log)).toBe(log);
  });

  it("keeps the last section full and compresses earlier ones", () => {
    const log = `# Header

## Iteration 1 (loop 1/5)
- **Change applied**: changed foo
- **Expected result**: better PnL
- **Next steps if fails**: if X then Y

## Iteration 2 (loop 2/5)
- **Change applied**: changed bar
- **Expected result**: lower DD
- **Next steps if fails**: if A then B

## Iteration 3 (loop 3/5)
- **Change applied**: changed baz
- **Expected result**: more trades`;

    const result = compressLog(log);

    // Last section (iter 3) should be full
    expect(result).toContain("## Iteration 3 (loop 3/5)");
    expect(result).toContain("changed baz");
    expect(result).toContain("more trades");

    // Earlier sections should be compressed
    expect(result).toContain("[compressed]");
    expect(result).toContain("Changes: changed foo");
  });

  it("drops sections beyond MAX_COMPRESSED_SECTIONS", () => {
    // Create 7 iterations — should keep last 1 full, compress 3, drop 3
    const sections = Array.from(
      { length: 7 },
      (_, i) =>
        `\n## Iteration ${i + 1}
- **Change applied**: change ${i + 1}
- **Next steps if fails**: step ${i + 1}`,
    );
    const log = "# Header" + sections.join("");
    const result = compressLog(log);

    expect(result).toContain("omitted");
    // Should contain iterations 5, 6, 7 (compressed: 5,6; full: 7)
    expect(result).toContain("Iteration 7");
    // Should NOT contain iteration 1 content
    expect(result).not.toContain("change 1");
  });
});

// --- Phase 1: Builder function tests ---

describe("buildTradeAnalysisSection", () => {
  it("renders full trade analysis with all data", () => {
    const result = buildTradeAnalysisSection(sampleTradeAnalysis);
    expect(result).toContain("TRADE ANALYSIS");
    expect(result).toContain("TP1");
    expect(result).toContain("SL");
    expect(result).toContain("long: 100t");
    expect(result).toContain("short: 80t");
    expect(result).toContain("14h:");
    expect(result).toContain("03h:");
    expect(result).toContain("Mon:+50");
    expect(result).toContain("winners=8 bars");
    expect(result).toContain("losers=3 bars");
  });

  it("shows (no data) marker when byExitType is empty", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byExitType: [],
    };
    const result = buildTradeAnalysisSection(ta);
    expect(result).toContain("(no data)");
  });

  it("handles empty bestHoursUTC and worstHoursUTC", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      bestHoursUTC: [],
      worstHoursUTC: [],
    };
    const result = buildTradeAnalysisSection(ta);
    expect(result).toContain("TRADE ANALYSIS");
    // Should not crash — just empty hour lists
    expect(result).toContain("Best hours UTC");
  });

  it("handles unknown direction", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byDirection: { unknown: { count: 10, pnl: -5, winRate: 10, profitFactor: 0.9, avgTrade: -0.5 } },
    };
    const result = buildTradeAnalysisSection(ta);
    expect(result).toContain("unknown: 10t");
  });

  it("renders session breakdown when bySession is available", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      bySession: {
        Asia: { count: 40, pnl: 25.5, winRate: 55.0, profitFactor: 1.8 },
        London: { count: 60, pnl: 80.0, winRate: 48.3, profitFactor: 2.1 },
        NY: { count: 70, pnl: 90.0, winRate: 42.9, profitFactor: 1.6 },
        "Off-peak": { count: 10, pnl: 4.5, winRate: 50.0, profitFactor: 1.2 },
      },
    };
    const result = buildTradeAnalysisSection(ta);
    expect(result).toContain("By session:");
    expect(result).toContain("Asia");
    expect(result).toContain("London");
    expect(result).toContain("NY");
    expect(result).toContain("Off-peak");
  });
});

describe("buildPineParamsSection", () => {
  it("renders params with filters ON and OFF", () => {
    const result = buildPineParamsSection({
      riskTradeUsd: 10,
      atrMult: 4.5,
      maxBarsToTp1: 20,
      cooldownBars: 3,
      rr1: 0.5,
      rr2: 4.0,
      filters: { useRsi: true, useVwap: false, useSuper: true },
      blockedHours: [],
      blockedDays: [],
    });
    expect(result).toContain("CURRENT .PINE PARAMETERS");
    expect(result).toContain("riskTradeUsd=10");
    expect(result).toContain("atrMult=4.5");
    expect(result).toContain("Filters ON:  useRsi, useSuper");
    expect(result).toContain("Filters OFF: useVwap");
  });

  it("renders Session ORB + Squeeze params", () => {
    const result = buildPineParamsSection({
      riskTradeUsd: 5,
      slAtrMult: 1.5,
      rrTarget: 3.0,
      maxBarsInTrade: 60,
      cooldownBars: 4,
      adxMin: 20.0,
      kcMult: 1.5,
      filters: { useDayFilter: true },
      blockedHours: [],
      blockedDays: [],
    });
    expect(result).toContain("CURRENT .PINE PARAMETERS");
    expect(result).toContain("riskTradeUsd=5");
    expect(result).toContain("slAtrMult=1.5");
    expect(result).toContain("rrTarget=3");
    expect(result).toContain("maxBarsInTrade=60");
    expect(result).toContain("adxMin=20");
    expect(result).toContain("kcMult=1.5");
    expect(result).toContain("Filters ON:  useDayFilter");
  });

  it("returns empty string for null pineParams", () => {
    expect(buildPineParamsSection(null)).toBe("");
  });

  it("shows 'none' when no filters are on or off", () => {
    const result = buildPineParamsSection({
      filters: {},
      blockedHours: [],
      blockedDays: [],
    });
    expect(result).toContain("Filters ON:  none");
    expect(result).toContain("Filters OFF: none");
    expect(result).toContain("none found");
  });
});

describe("buildComplexitySection", () => {
  it("returns empty string for null pineParams", () => {
    expect(buildComplexitySection(null)).toBe("");
  });

  it("renders complexity without warnings", () => {
    const result = buildComplexitySection({
      filters: { useRsi: true },
      blockedHours: [3, 4],
      blockedDays: ["Mon"],
    });
    expect(result).toContain("CURRENT COMPLEXITY");
    expect(result).toContain("Boolean filters ON: 1");
    expect(result).toContain("Blocked hours: 2 [3, 4]");
    expect(result).toContain("Blocked days: 1 [Mon]");
    expect(result).toContain("Total active filters: 4");
    expect(result).not.toContain("FORBIDDEN");
  });

  it("emits FORBIDDEN warning when >12 hours blocked", () => {
    const result = buildComplexitySection({
      filters: {},
      blockedHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      blockedDays: [],
    });
    expect(result).toContain("FORBIDDEN to add more hour filters");
    expect(result).toContain("14/24");
  });

  it("emits FORBIDDEN warning when >3 days blocked", () => {
    const result = buildComplexitySection({
      filters: {},
      blockedHours: [],
      blockedDays: ["Mon", "Tue", "Wed", "Thu"],
    });
    expect(result).toContain("FORBIDDEN to add more day filters");
    expect(result).toContain("4/7");
  });

  it("emits both warnings simultaneously", () => {
    const result = buildComplexitySection({
      filters: {},
      blockedHours: Array.from({ length: 14 }, (_, i) => i),
      blockedDays: ["Mon", "Tue", "Wed", "Thu"],
    });
    expect(result).toContain("FORBIDDEN to add more hour filters");
    expect(result).toContain("FORBIDDEN to add more day filters");
  });
});

describe("buildOverfitSection", () => {
  it("returns empty string when paramHistory is null", () => {
    expect(buildOverfitSection(null, null)).toBe("");
  });

  it("returns empty string with fewer than 3 iterations", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "2026-01-01", change: { param: "atrMult", from: 4, to: 5 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "2026-01-02", change: { param: "rr1", from: 0.5, to: 0.7 }, before: null, after: { pnl: 120, trades: 175, pf: 1.4 }, verdict: "improved" },
      ],
    });
    expect(buildOverfitSection(ph, null)).toBe("");
  });

  it("warns red on 3+ consecutive hour/day filters", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "2026-01-01", change: { param: "badHour", from: null, to: 3 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "2026-01-02", change: { param: "badHour", from: null, to: 4 }, before: null, after: { pnl: 110, trades: 170, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "2026-01-03", change: { param: "badHour", from: null, to: 5 }, before: null, after: { pnl: 115, trades: 160, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, null);
    expect(result).toContain("ROBUSTNESS DIAGNOSTIC");
    expect(result).toContain("3 consecutive hour/day filters");
  });

  it("warns yellow on 2 consecutive hour/day filters", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "2026-01-01", change: { param: "atrMult", from: 4, to: 5 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "2026-01-02", change: { param: "badHour", from: null, to: 3 }, before: null, after: { pnl: 110, trades: 170, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "2026-01-03", change: { param: "badDay", from: null, to: "Mon" }, before: null, after: { pnl: 115, trades: 160, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, null);
    expect(result).toContain("2 consecutive hour/day filters");
  });

  it("warns on trade count drop >=35%", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "2026-01-01", change: { param: "x", from: 1, to: 2 }, before: null, after: { pnl: 100, trades: 200, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "2026-01-02", change: { param: "y", from: 2, to: 3 }, before: null, after: { pnl: 110, trades: 150, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "2026-01-03", change: { param: "z", from: 3, to: 4 }, before: null, after: { pnl: 120, trades: 120, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, null);
    expect(result).toContain("Trade count dropped");
    expect(result).toContain("200");
    expect(result).toContain("120");
  });

  it("warns on diminishing returns", () => {
    // 6+ iterations: early gains large, late gains tiny
    // delta = cur.after.pnl - prev.before.pnl
    // deltas: [110, 110, 55, 7, 3] → avgEarly=110, avgLate=21.67 < 110*0.4=44
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "a", from: 0, to: 1 }, before: { pnl: 50, trades: 180, pf: 1.0 }, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "b", from: 0, to: 1 }, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 160, trades: 180, pf: 1.5 }, verdict: "improved" },
        { iter: 3, date: "d", change: { param: "c", from: 0, to: 1 }, before: { pnl: 160, trades: 180, pf: 1.5 }, after: { pnl: 215, trades: 180, pf: 1.6 }, verdict: "improved" },
        { iter: 4, date: "d", change: { param: "d", from: 0, to: 1 }, before: { pnl: 215, trades: 180, pf: 1.6 }, after: { pnl: 222, trades: 180, pf: 1.62 }, verdict: "improved" },
        { iter: 5, date: "d", change: { param: "e", from: 0, to: 1 }, before: { pnl: 222, trades: 180, pf: 1.62 }, after: { pnl: 225, trades: 180, pf: 1.63 }, verdict: "improved" },
        { iter: 6, date: "d", change: { param: "f", from: 0, to: 1 }, before: { pnl: 225, trades: 180, pf: 1.63 }, after: { pnl: 226, trades: 180, pf: 1.64 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, null);
    expect(result).toContain("Diminishing returns");
  });

  it("warns on walk-forward instability", () => {
    const wf = {
      trainTrades: 120,
      testTrades: 50,
      splitRatio: 0.7,
      hourConsistency: [
        { hour: 3, trainPnl: -20, trainCount: 10, testPnl: 15, testCount: 5, consistent: false },
        { hour: 5, trainPnl: -15, trainCount: 10, testPnl: 10, testCount: 5, consistent: false },
        { hour: 8, trainPnl: -10, trainCount: 10, testPnl: 8, testCount: 5, consistent: false },
      ],
      trainPF: null,
      testPF: null,
      pfRatio: null,
      overfitFlag: false,
    };
    const ta: TradeAnalysis = { ...sampleTradeAnalysis, walkForward: wf };
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "a", from: 0, to: 1 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "b", from: 0, to: 1 }, before: null, after: { pnl: 110, trades: 175, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "d", change: { param: "c", from: 0, to: 1 }, before: null, after: { pnl: 120, trades: 170, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, ta);
    expect(result).toContain("Walk-forward");
    expect(result).toContain("3 hours");
  });
});

describe("buildFilterSimsSection", () => {
  it("returns empty string for null tradeAnalysis", () => {
    expect(buildFilterSimsSection(null)).toBe("");
  });

  it("returns empty string when totalTrades is 0", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: { ...sampleTradeAnalysis.filterSimulations, totalTrades: 0 },
    };
    expect(buildFilterSimsSection(ta)).toBe("");
  });

  it("renders hours that improve PnL", () => {
    const result = buildFilterSimsSection(sampleTradeAnalysis);
    expect(result).toContain("FILTER SIMULATIONS");
    expect(result).toContain("Base: 180 trades");
    expect(result).toContain("IMPROVES PnL");
    expect(result).toContain("03h UTC");
  });

  it("renders hours that hurt PnL", () => {
    const result = buildFilterSimsSection(sampleTradeAnalysis);
    expect(result).toContain("WORSENS PnL");
    expect(result).toContain("10h UTC");
  });

  it("renders walk-forward section when available", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      walkForward: {
        trainTrades: 120,
        testTrades: 50,
        splitRatio: 0.7,
        hourConsistency: [
          { hour: 3, trainPnl: -20, trainCount: 10, testPnl: -15, testCount: 5, consistent: true },
          { hour: 14, trainPnl: 30, trainCount: 15, testPnl: 25, testCount: 8, consistent: true },
        ],
        trainPF: 1.85,
        testPF: 1.22,
        pfRatio: 0.66,
        overfitFlag: false,
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("Walk-forward");
    expect(result).toContain("train=120t");
    expect(result).toContain("test=50t");
    expect(result).toContain("PF train: 1.85");
    expect(result).toContain("PF test: 1.22");
    expect(result).toContain("Ratio: 0.66");
    expect(result).toContain("✓ yes");
    expect(result).toContain("RULE: only consider blocking hour");
  });

  it("renders overfit warning when pfRatio < 0.6", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      walkForward: {
        trainTrades: 120,
        testTrades: 50,
        splitRatio: 0.7,
        hourConsistency: [
          { hour: 14, trainPnl: 30, trainCount: 15, testPnl: 25, testCount: 8, consistent: true },
        ],
        trainPF: 2.5,
        testPF: 1.1,
        pfRatio: 0.44,
        overfitFlag: true,
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("OVERFIT DETECTED");
    expect(result).toContain("PF_test / PF_train < 0.6");
  });

  it("renders day simulations improving and hurting", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: {
        ...sampleTradeAnalysis.filterSimulations,
        byDay: [
          { day: "Mon", tradesRemoved: 20, pnlDelta: 30, pnlAfter: 230, tradesAfter: 160 },
          { day: "Sat", tradesRemoved: 10, pnlDelta: -15, pnlAfter: 185, tradesAfter: 170 },
        ],
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("Block day — IMPROVES PnL");
    expect(result).toContain("Mon");
    expect(result).toContain("Block day — WORSENS PnL");
    expect(result).toContain("Sat");
  });

  it("renders SL critical as informational note (no trigger)", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: {
        ...sampleTradeAnalysis.filterSimulations,
        totalPnl: 100,
        removeAllSL: { tradesRemoved: 100, pnlDelta: 150, pnlAfter: 250, tradesAfter: 80 },
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).not.toContain("CRITERION FOR atrMult");
    expect(result).toContain("SL destroys");
    expect(result).toContain("(informational — follow core param priority)");
  });
});

describe("buildExploredSpaceSection", () => {
  it("returns empty string for null paramHistory", () => {
    expect(buildExploredSpaceSection(null, 1, 1, 5)).toBe("");
  });

  it("renders explored ranges and neverWorked", () => {
    const ph = makeParamHistory({
      exploredRanges: { atrMult: [3.5, 4.0, 4.5] },
      neverWorked: [{ param: "useVwap", value: true, reason: "PnL caiu", iter: 3 }],
      iterations: [
        { iter: 1, date: "d", change: { param: "atrMult", from: 4, to: 4.5 }, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 120, trades: 175, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildExploredSpaceSection(ph, 5, 2, 5);
    expect(result).toContain("EXPLORED SPACE");
    expect(result).toContain("atrMult: tested [3.5, 4, 4.5]");
    expect(result).toContain("useVwap=true");
    expect(result).toContain("PnL caiu");
    expect(result).toContain("Global iteration: 5");
  });

  it("renders last changes with verdict icons", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "atrMult", from: 4, to: 5 }, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 120, trades: 175, pf: 1.4 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "rr1", from: 0.5, to: 0.7 }, before: { pnl: 120, trades: 175, pf: 1.4 }, after: { pnl: 90, trades: 180, pf: 1.1 }, verdict: "degraded" },
      ],
    });
    const result = buildExploredSpaceSection(ph, 3, 1, 5);
    expect(result).toContain("atrMult 4→5");
    expect(result).toContain("✓");
    expect(result).toContain("rr1 0.5→0.7");
    expect(result).toContain("✗");
  });
});

describe("buildPendingHypothesesSection", () => {
  it("returns empty string for null paramHistory", () => {
    expect(buildPendingHypothesesSection(null)).toBe("");
  });

  it("returns empty string when pending is empty", () => {
    const ph = makeParamHistory({ pendingHypotheses: [] });
    expect(buildPendingHypothesesSection(ph)).toBe("");
  });

  it("renders pending hypotheses without SL context injection", () => {
    const ph = makeParamHistory({
      pendingHypotheses: [
        { iter: 2, rank: 2, hypothesis: "Testar atrMult 5.0", expired: false, condition: "se PnL < 200" },
      ],
    });
    const result = buildPendingHypothesesSection(ph);
    expect(result).toContain("PENDING HYPOTHESES");
    expect(result).toContain("iter 2 rank#2");
    expect(result).toContain("Testar atrMult 5.0");
    expect(result).toContain("condition: se PnL < 200");
    expect(result).not.toContain("Current SL destroys");
  });

  it("skips expired hypotheses", () => {
    const ph = makeParamHistory({
      pendingHypotheses: [
        { iter: 1, rank: 1, hypothesis: "Old hypothesis", expired: true },
        { iter: 2, rank: 1, hypothesis: "Active hypothesis", expired: false },
      ],
    });
    const result = buildPendingHypothesesSection(ph);
    expect(result).not.toContain("Old hypothesis");
    expect(result).toContain("Active hypothesis");
  });
});

describe("buildApproachHistorySection", () => {
  it("returns empty string for null paramHistory", () => {
    expect(buildApproachHistorySection(null)).toBe("");
  });

  it("returns empty string when no approaches", () => {
    expect(buildApproachHistorySection(makeParamHistory())).toBe("");
  });

  it("renders approaches with verdicts", () => {
    const ph = makeParamHistory({
      approaches: [
        { id: 1, name: "Donchian Breakout", indicators: ["Donchian", "ATR"], startIter: 1, endIter: 8, bestScore: 72, bestMetrics: { pnl: 250, pf: 1.5, wr: 32 }, verdict: "exhausted", reason: "diminishing returns" },
        { id: 2, name: "RSI Mean Revert", indicators: ["RSI", "BB"], startIter: 9, endIter: 12, bestScore: 65, bestMetrics: { pnl: 180, pf: 1.3, wr: 28 }, verdict: "active" },
      ],
    });
    const result = buildApproachHistorySection(ph);
    expect(result).toContain("APPROACH HISTORY");
    expect(result).toContain("EXHAUSTED");
    expect(result).toContain("ACTIVE");
    expect(result).toContain("Donchian Breakout");
    expect(result).toContain("diminishing returns");
  });
});

describe("buildTradeAnalysisSection — edge cases", () => {
  it("shows ? for null avgBarsWinners and avgBarsLosers", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      avgBarsWinners: null,
      avgBarsLosers: null,
    };
    const result = buildTradeAnalysisSection(ta);
    expect(result).toContain("winners=? bars");
    expect(result).toContain("losers=? bars");
  });

  it("renders negative PnL with minus sign in byDirection", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byDirection: {
        long: { count: 50, pnl: -30, winRate: 20, profitFactor: 0.7, avgTrade: -0.6 },
      },
    };
    const result = buildTradeAnalysisSection(ta);
    expect(result).toContain("PnL=-30");
  });
});

describe("buildOverfitSection — edge cases", () => {
  it("warns on totalHourDayFilters >= 6", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "badHour", from: null, to: 3 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "atrMult", from: 4, to: 5 }, before: null, after: { pnl: 110, trades: 175, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "d", change: { param: "badHour", from: null, to: 4 }, before: null, after: { pnl: 115, trades: 170, pf: 1.4 }, verdict: "improved" },
        { iter: 4, date: "d", change: { param: "badHour", from: null, to: 5 }, before: null, after: { pnl: 118, trades: 165, pf: 1.4 }, verdict: "improved" },
        { iter: 5, date: "d", change: { param: "badDay", from: null, to: "Mon" }, before: null, after: { pnl: 120, trades: 160, pf: 1.4 }, verdict: "improved" },
        { iter: 6, date: "d", change: { param: "badDay", from: null, to: "Tue" }, before: null, after: { pnl: 122, trades: 155, pf: 1.4 }, verdict: "improved" },
        { iter: 7, date: "d", change: { param: "useDayFilter", from: false, to: true }, before: null, after: { pnl: 123, trades: 150, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, null);
    expect(result).toContain("Total of 6 hour/day filters");
  });

  it("warns yellow on trade count drop 20-35%", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "x", from: 1, to: 2 }, before: null, after: { pnl: 100, trades: 200, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "y", from: 2, to: 3 }, before: null, after: { pnl: 110, trades: 180, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "d", change: { param: "z", from: 3, to: 4 }, before: null, after: { pnl: 120, trades: 155, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, null);
    expect(result).toContain("Trade count dropped");
    // 22.5% drop → yellow warning
    expect(result).toContain("200");
    expect(result).toContain("155");
  });

  it("warns yellow on 1 unstable walk-forward hour", () => {
    const wf = {
      trainTrades: 120,
      testTrades: 50,
      splitRatio: 0.7,
      hourConsistency: [
        { hour: 3, trainPnl: -20, trainCount: 10, testPnl: 15, testCount: 5, consistent: false },
      ],
      trainPF: null, testPF: null, pfRatio: null, overfitFlag: false,
    };
    const ta: TradeAnalysis = { ...sampleTradeAnalysis, walkForward: wf };
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "a", from: 0, to: 1 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "b", from: 0, to: 1 }, before: null, after: { pnl: 110, trades: 175, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "d", change: { param: "c", from: 0, to: 1 }, before: null, after: { pnl: 120, trades: 170, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, ta);
    expect(result).toContain("1 hour(s) with unstable direction");
  });

  it("handles null after values in diminishing returns calculation", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "a", from: 0, to: 1 }, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 110, trades: 180, pf: 1.35 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "b", from: 0, to: 1 }, before: null, after: null, verdict: "neutral" },
        { iter: 3, date: "d", change: { param: "c", from: 0, to: 1 }, before: { pnl: 110, trades: 180, pf: 1.35 }, after: { pnl: 115, trades: 180, pf: 1.37 }, verdict: "improved" },
        { iter: 4, date: "d", change: { param: "d", from: 0, to: 1 }, before: { pnl: 115, trades: 180, pf: 1.37 }, after: { pnl: 118, trades: 180, pf: 1.38 }, verdict: "improved" },
        { iter: 5, date: "d", change: { param: "e", from: 0, to: 1 }, before: { pnl: 118, trades: 180, pf: 1.38 }, after: { pnl: 120, trades: 180, pf: 1.39 }, verdict: "improved" },
      ],
    });
    // Should not crash — null after is gracefully filtered out
    const result = buildOverfitSection(ph, null);
    expect(typeof result).toBe("string");
  });

  it("returns empty when no warnings apply", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "atrMult", from: 4, to: 5 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "rr1", from: 0.5, to: 0.7 }, before: null, after: { pnl: 120, trades: 178, pf: 1.4 }, verdict: "improved" },
        { iter: 3, date: "d", change: { param: "rr2", from: 3.0, to: 3.5 }, before: null, after: { pnl: 130, trades: 176, pf: 1.45 }, verdict: "improved" },
      ],
    });
    expect(buildOverfitSection(ph, null)).toBe("");
  });
});

describe("buildFilterSimsSection — edge cases", () => {
  it("renders walk-forward with null PFs", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      walkForward: {
        trainTrades: 120,
        testTrades: 50,
        splitRatio: 0.7,
        hourConsistency: [
          { hour: 14, trainPnl: 30, trainCount: 15, testPnl: 25, testCount: 8, consistent: true },
        ],
        trainPF: null,
        testPF: null,
        pfRatio: null,
        overfitFlag: false,
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("Walk-forward");
    // Should still show hour table without PF line
    expect(result).toContain("14h UTC");
    expect(result).not.toContain("PF train:");
  });

  it("renders SL ratio as infinity when totalPnl is near zero", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: {
        ...sampleTradeAnalysis.filterSimulations,
        totalPnl: 0.001,
        removeAllSL: { tradesRemoved: 50, pnlDelta: 100, pnlAfter: 100, tradesAfter: 130 },
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("∞");
  });

  it("handles no SL trades", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: {
        ...sampleTradeAnalysis.filterSimulations,
        removeAllSL: { tradesRemoved: 0, pnlDelta: 0, pnlAfter: 200, tradesAfter: 180 },
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).not.toContain("Upper bound (remove all SL)");
  });

  it("handles no improving or hurting hours", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: {
        totalPnl: 200,
        totalTrades: 180,
        byHour: [],
        byDay: [],
        removeAllSL: { tradesRemoved: 0, pnlDelta: 0, pnlAfter: 200, tradesAfter: 180 },
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("FILTER SIMULATIONS");
    expect(result).not.toContain("Block hour");
  });

  it("renders walk-forward hour with consistent=false", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      walkForward: {
        trainTrades: 120, testTrades: 50, splitRatio: 0.7,
        hourConsistency: [
          { hour: 3, trainPnl: -20, trainCount: 10, testPnl: 15, testCount: 5, consistent: false },
        ],
        trainPF: null, testPF: null, pfRatio: null, overfitFlag: false,
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("✗ NO (unstable");
  });

  it("renders walk-forward hour with consistent=null (no data)", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      walkForward: {
        trainTrades: 120, testTrades: 50, splitRatio: 0.7,
        hourConsistency: [
          { hour: 8, trainPnl: 10, trainCount: 3, testPnl: 5, testCount: 1, consistent: null as any },
        ],
        trainPF: null, testPF: null, pfRatio: null, overfitFlag: false,
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("? no data");
  });

  it("renders walk-forward with PF values and overfit flag", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      walkForward: {
        trainTrades: 120, testTrades: 50, splitRatio: 0.7,
        hourConsistency: [
          { hour: 14, trainPnl: 30, trainCount: 15, testPnl: 25, testCount: 8, consistent: true },
        ],
        trainPF: 1.8, testPF: 0.9, pfRatio: 0.5, overfitFlag: true,
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("PF train: 1.80");
    expect(result).toContain("PF test: 0.90");
    expect(result).toContain("Ratio: 0.50");
    expect(result).toContain("OVERFIT DETECTED");
  });

  it("renders SL critical as informational (no trigger) even when SL > PnL", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: {
        ...sampleTradeAnalysis.filterSimulations,
        totalPnl: 50,
        removeAllSL: { tradesRemoved: 80, pnlDelta: 100, pnlAfter: 150, tradesAfter: 100 },
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).not.toContain("CRITERION FOR atrMult");
    expect(result).toContain("(informational — follow core param priority)");
  });
});

describe("buildExploredSpaceSection — edge cases", () => {
  it("renders string neverWorked entries (legacy format)", () => {
    const ph = makeParamHistory({
      neverWorked: ["useVwap=true caused PnL drop" as any],
      iterations: [
        { iter: 1, date: "d", change: { param: "a", from: 0, to: 1 }, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 110, trades: 180, pf: 1.35 }, verdict: "improved" },
      ],
    });
    const result = buildExploredSpaceSection(ph, 2, 1, 5);
    expect(result).toContain("useVwap=true caused PnL drop");
  });

  it("renders note in iteration changes", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "atrMult", from: 4, to: 5 }, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 120, trades: 175, pf: 1.4 }, verdict: "improved", note: "targeting wider stops" },
      ],
    });
    const result = buildExploredSpaceSection(ph, 2, 1, 5);
    expect(result).toContain("targeting wider stops");
  });

  it("renders neutral verdict with warning icon", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "x", from: 1, to: 2 }, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 102, trades: 180, pf: 1.31 }, verdict: "neutral" },
      ],
    });
    const result = buildExploredSpaceSection(ph, 2, 1, 5);
    expect(result).toContain("⚠");
  });

  it("shows iteration with missing change as (?)", () => {
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: null, before: { pnl: 100, trades: 180, pf: 1.3 }, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "neutral" },
      ],
    });
    const result = buildExploredSpaceSection(ph, 2, 1, 5);
    expect(result).toContain("(?)");
  });
});

describe("buildPendingHypothesesSection — edge cases", () => {
  it("renders hypothesis without condition or atrMult context", () => {
    const ph = makeParamHistory({
      pendingHypotheses: [
        { iter: 2, rank: 2, hypothesis: "Try session filter", expired: false },
      ],
    });
    const result = buildPendingHypothesesSection(ph);
    expect(result).toContain("Try session filter");
    expect(result).not.toContain("Current SL");
    expect(result).not.toContain("condition:");
  });
});

describe("buildDiagnosticInstruction", () => {
  it("returns PARAMETRIC/STRUCTURAL for refine phase", () => {
    const result = buildDiagnosticInstruction("refine");
    expect(result).toContain("PARAMETRIC");
    expect(result).toContain("STRUCTURAL");
  });

  it("returns evaluation instruction for research phase", () => {
    const result = buildDiagnosticInstruction("research");
    expect(result).toContain("evaluate");
    expect(result).toContain("progressing");
  });
});

// --- New builder tests ---

describe("buildCoreParamsSection", () => {
  it("returns empty string when coreParams is undefined", () => {
    expect(buildCoreParamsSection(undefined, {})).toBe("");
  });

  it("returns empty string when coreParams is empty array", () => {
    expect(buildCoreParamsSection([], {})).toBe("");
  });

  it("shows partial coverage with remaining values", () => {
    const coreParams = [
      { name: "dcSlow", min: 30, max: 50, step: 10 },
    ];
    const explored = { dcSlow: [30, 40] };
    const result = buildCoreParamsSection(coreParams, explored);
    expect(result).toContain("CORE PARAMETERS");
    expect(result).toContain("dcSlow: 2/3 tested");
    expect(result).toContain("remaining: [50]");
    expect(result).toContain("RULE: Core params MUST be tested in STRICT SEQUENTIAL ORDER");
  });

  it("shows COMPLETE when all values tested", () => {
    const coreParams = [
      { name: "dcSlow", min: 30, max: 50, step: 10 },
    ];
    const explored = { dcSlow: [30, 40, 50] };
    const result = buildCoreParamsSection(coreParams, explored);
    expect(result).toContain("dcSlow: COMPLETE");
    expect(result).not.toContain("RULE:");
  });

  it("handles no explored ranges", () => {
    const coreParams = [
      { name: "kcLen", min: 10, max: 20, step: 5 },
    ];
    const result = buildCoreParamsSection(coreParams, undefined);
    expect(result).toContain("kcLen: 0/3 tested");
    expect(result).toContain("remaining: [10, 15, 20]");
  });

  it("shows NEXT marker on first incomplete param and BLOCKED on others", () => {
    const coreParams = [
      { name: "dcSlow", min: 30, max: 50, step: 10 },
      { name: "dcFast", min: 10, max: 20, step: 5 },
      { name: "atrStopMult", min: 1.5, max: 3.0, step: 0.5 },
    ];
    const explored = { dcSlow: [30] };
    const result = buildCoreParamsSection(coreParams, explored);
    expect(result).toContain("dcSlow: 1/3 tested");
    expect(result).toContain("→ NEXT");
    expect(result).toContain("dcFast:");
    expect(result).toContain("[BLOCKED");
    expect(result).toContain("atrStopMult:");
    expect(result).toContain("[BLOCKED");
    expect(result).toContain("STRICT SEQUENTIAL ORDER");
  });

  it("does not block params after first complete one", () => {
    const coreParams = [
      { name: "dcSlow", min: 30, max: 50, step: 10 },
      { name: "dcFast", min: 10, max: 20, step: 5 },
    ];
    const explored = { dcSlow: [30, 40, 50] };
    const result = buildCoreParamsSection(coreParams, explored);
    expect(result).toContain("dcSlow: COMPLETE");
    expect(result).toContain("dcFast:");
    expect(result).toContain("→ NEXT");
    // No param line should have [BLOCKED] — only dcFast exists and it should be NEXT
    expect(result).not.toContain("[BLOCKED — wait");
  });
});

describe("buildDesignChecklistSection", () => {
  it("returns empty string when checklist is undefined", () => {
    expect(buildDesignChecklistSection(undefined, 1)).toBe("");
  });

  it("returns empty string when globalIter > 1", () => {
    const checklist = ["Donchian channel entry"];
    expect(buildDesignChecklistSection(checklist, 2)).toBe("");
  });

  it("renders checklist on iteration 1", () => {
    const checklist = [
      "Donchian channel entry (dcSlow breakout)",
      "ADX consolidation filter",
    ];
    const result = buildDesignChecklistSection(checklist, 1);
    expect(result).toContain("PRE-CHECK");
    expect(result).toContain("[ ] Donchian channel entry (dcSlow breakout)");
    expect(result).toContain("[ ] ADX consolidation filter");
  });

  it("returns empty string when checklist is empty", () => {
    expect(buildDesignChecklistSection([], 1)).toBe("");
  });
});

describe("buildOverfitSection — directional bias", () => {
  it("warns red on PF < 0.5 with enough trades", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byDirection: {
        long: { count: 50, pnl: -100, winRate: 15, profitFactor: 0.35, avgTrade: -2.0 },
        short: { count: 80, pnl: 200, winRate: 45, profitFactor: 1.8, avgTrade: 2.5 },
      },
    };
    // No param history → iters < 3, but directional bias should still trigger
    const result = buildOverfitSection(null, ta);
    expect(result).toContain("DIRECTIONAL BIAS");
    expect(result).toContain("long PF=0.35");
    expect(result).toContain("STRUCTURAL");
  });

  it("warns yellow on PF < 0.8 with enough trades", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byDirection: {
        long: { count: 50, pnl: -20, winRate: 22, profitFactor: 0.75, avgTrade: -0.4 },
        short: { count: 80, pnl: 200, winRate: 45, profitFactor: 1.8, avgTrade: 2.5 },
      },
    };
    const result = buildOverfitSection(null, ta);
    expect(result).toContain("WEAK DIRECTION");
    expect(result).toContain("long PF=0.75");
  });

  it("does not warn when count < 10", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byDirection: {
        long: { count: 5, pnl: -50, winRate: 10, profitFactor: 0.2, avgTrade: -10 },
        short: { count: 80, pnl: 200, winRate: 45, profitFactor: 1.8, avgTrade: 2.5 },
      },
    };
    const result = buildOverfitSection(null, ta);
    // long has count < 10, should not trigger
    expect(result).not.toContain("DIRECTIONAL BIAS");
    expect(result).not.toContain("WEAK DIRECTION");
  });

  it("does not warn when PF >= 0.8", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byDirection: {
        long: { count: 50, pnl: 100, winRate: 30, profitFactor: 0.95, avgTrade: 2.0 },
        short: { count: 80, pnl: 200, winRate: 45, profitFactor: 1.8, avgTrade: 2.5 },
      },
    };
    const result = buildOverfitSection(null, ta);
    expect(result).toBe("");
  });

  it("renders directional bias even with 3+ iterations (combined with other warnings)", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      byDirection: {
        long: { count: 50, pnl: -100, winRate: 15, profitFactor: 0.35, avgTrade: -2.0 },
        short: { count: 80, pnl: 200, winRate: 45, profitFactor: 1.8, avgTrade: 2.5 },
      },
    };
    const ph = makeParamHistory({
      iterations: [
        { iter: 1, date: "d", change: { param: "a", from: 0, to: 1 }, before: null, after: { pnl: 100, trades: 180, pf: 1.3 }, verdict: "improved" },
        { iter: 2, date: "d", change: { param: "b", from: 0, to: 1 }, before: null, after: { pnl: 110, trades: 175, pf: 1.35 }, verdict: "improved" },
        { iter: 3, date: "d", change: { param: "c", from: 0, to: 1 }, before: null, after: { pnl: 120, trades: 170, pf: 1.4 }, verdict: "improved" },
      ],
    });
    const result = buildOverfitSection(ph, ta);
    expect(result).toContain("DIRECTIONAL BIAS");
    expect(result).toContain("ROBUSTNESS DIAGNOSTIC");
  });
});

describe("buildTradeAnalysisSection — PF and avgTrade in direction", () => {
  it("renders PF and avg in direction display", () => {
    const result = buildTradeAnalysisSection(sampleTradeAnalysis);
    expect(result).toContain("PF=1.15");
    expect(result).toContain("avg=+1.5 USD");
    expect(result).toContain("PF=1.05");
    expect(result).toContain("avg=+0.63 USD");
  });
});

describe("buildFilterSimsSection — day filter annotation", () => {
  it("annotates day sims as INFORMATION ONLY", () => {
    const ta: TradeAnalysis = {
      ...sampleTradeAnalysis,
      filterSimulations: {
        ...sampleTradeAnalysis.filterSimulations,
        byDay: [
          { day: "Mon", tradesRemoved: 20, pnlDelta: 30, pnlAfter: 230, tradesAfter: 160 },
        ],
      },
    };
    const result = buildFilterSimsSection(ta);
    expect(result).toContain("INFORMATION ONLY");
    expect(result).toContain("day filters FORBIDDEN");
  });
});
