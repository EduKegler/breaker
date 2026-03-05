import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatCatalogForPrompt, buildOptimizePrompt } from "./build-optimize-prompt.js";
import type { ComponentCatalog, CatalogSlot, ModuleContext } from "../lib/build-module-context.js";
import type { TestedCombination } from "../types/parameter-history.js";
import type { Metrics, TradeAnalysis, StrategyParam } from "@breaker/backtest";

// ---------------------------------------------------------------------------
// formatCatalogForPrompt
// ---------------------------------------------------------------------------

describe("formatCatalogForPrompt", () => {
  const baseCatalog: ComponentCatalog = {
    slots: [
      {
        slotName: "Entry Signal",
        typicalVars: "1-2",
        candidates: [
          { name: "Donchian Channel", description: "Breakout above/below N-period" },
          { name: "BB squeeze", description: "BB contracts inside KC" },
        ],
      },
      {
        slotName: "Regime Filter",
        typicalVars: "0-1",
        candidates: [
          { name: "EMA direction", description: "Trend aligned with EMA" },
          { name: "ADX threshold", description: "ADX < threshold = consolidation" },
        ],
      },
    ],
  };

  it("marks locked candidates with [LOCKED]", () => {
    const result = formatCatalogForPrompt(baseCatalog, [], "entry: Donchian");
    expect(result).toContain("[LOCKED]");
    expect(result).toContain("Donchian Channel [LOCKED]");
  });

  it("marks tested candidates with [TESTED]", () => {
    const tested: TestedCombination[] = [
      { iter: 1, components: { "Entry Signal": "BB squeeze" }, bestMetrics: null },
    ];
    const result = formatCatalogForPrompt(baseCatalog, tested);
    expect(result).toContain("BB squeeze [TESTED]");
  });

  it("shows variable budget per slot", () => {
    const result = formatCatalogForPrompt(baseCatalog, []);
    expect(result).toContain("Entry Signal (1-2 vars)");
    expect(result).toContain("Regime Filter (0-1 vars)");
  });

  it("returns fallback when catalog is empty", () => {
    const result = formatCatalogForPrompt({ slots: [] }, []);
    expect(result).toContain("No catalog available");
  });

  it("shows previously tested combinations", () => {
    const tested: TestedCombination[] = [
      {
        iter: 3,
        components: { "Entry Signal": "Donchian Channel", "Regime Filter": "EMA direction" },
        bestMetrics: { pnl: 100, pf: 1.5, wr: 45, dd: 8, trades: 50 },
      },
    ];
    const result = formatCatalogForPrompt(baseCatalog, tested);
    expect(result).toContain("Previously Tested Combinations");
    expect(result).toContain("iter 3");
    expect(result).toContain("PF=1.5");
    expect(result).toContain("Do NOT repeat");
  });
});

// ---------------------------------------------------------------------------
// Module-specific session sanity checks (KB §13.2)
// ---------------------------------------------------------------------------

describe("buildOptimizePrompt session sanity (KB §13.2)", () => {
  function makeModuleContext(moduleId: string, profile: string): ModuleContext {
    return {
      profile,
      moduleId,
      moduleName: moduleId === "M1" ? "Breakout" : moduleId === "M2" ? "Mean Reversion" : "Generic",
      fixedRules: "1. test rule",
      restructureLocks: "",
      varCap: 8,
      stoppingCriteria: "- Trades >= 50",
      signalTF: "15m",
      regimeTF: "4H",
      catalog: { slots: [] },
    };
  }

  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return {
      totalPnl: 500,
      numTrades: 60,
      profitFactor: 1.5,
      maxDrawdownPct: 5,
      winRate: 45,
      avgR: 0.2,
      grossProfit: 1000,
      grossLoss: -500,
      avgWin: 20,
      avgLoss: -10,
      maxConsecutiveLosses: 3,
      expectancy: 5,
      ...overrides,
    };
  }

  function makeAnalysis(sessions: Record<string, { count: number; pnl: number; winRate: number; profitFactor: number }>, overrides?: Partial<TradeAnalysis>): TradeAnalysis {
    return {
      totalExitRows: 60,
      byDirection: { long: { count: 30, pnl: 300, winRate: 50, profitFactor: 1.5, avgTrade: 10 }, short: { count: 30, pnl: 200, winRate: 40, profitFactor: 1.3, avgTrade: 6.67 } },
      bySession: sessions as any,
      byExitType: [],
      byDayOfWeek: {},
      best3TradesPnl: [50, 40, 30],
      worst3TradesPnl: [-30, -25, -20],
      avgBarsWinners: 10,
      avgBarsLosers: 5,
      walkForward: null,
      ...overrides,
    };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 1,
    maxIter: 10,
    globalIter: 1,
    paramHistoryPath: "/fake/ph.json",
    artifactsDir: "/fake/artifacts",
  };

  it("M2 flags session inconsistency with MR-specific message", () => {
    const analysis = makeAnalysis({
      Asia: { count: 20, pnl: 400, winRate: 60, profitFactor: 2.5 },
      London: { count: 20, pnl: 50, winRate: 40, profitFactor: 0.5 },
      NY: { count: 20, pnl: 50, winRate: 40, profitFactor: 0.6 },
      "Off-peak": { count: 0, pnl: 0, winRate: 0, profitFactor: 0 },
    });

    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: analysis,
      moduleContext: makeModuleContext("M2", "mean-reversion"),
    });

    expect(prompt).toContain("MR SESSION INCONSISTENCY");
    expect(prompt).toContain("KB §13.2");
    expect(prompt).toContain("consistent 24/7");
  });

  it("M1 flags high Asia PF as anomalous for breakout", () => {
    const analysis = makeAnalysis({
      Asia: { count: 20, pnl: 400, winRate: 60, profitFactor: 2.5 },
      London: { count: 20, pnl: 50, winRate: 40, profitFactor: 0.8 },
      NY: { count: 20, pnl: 50, winRate: 40, profitFactor: 0.9 },
      "Off-peak": { count: 0, pnl: 0, winRate: 0, profitFactor: 0 },
    });

    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: analysis,
      moduleContext: makeModuleContext("M1", "breakout"),
    });

    expect(prompt).toContain("BREAKOUT SESSION ANOMALY");
    expect(prompt).toContain("KB §13.2");
    expect(prompt).toContain("Asia");
  });

  it("M1 does NOT flag when London/NY PF is higher than Asia (expected pattern)", () => {
    const analysis = makeAnalysis({
      Asia: { count: 20, pnl: 50, winRate: 35, profitFactor: 0.8 },
      London: { count: 20, pnl: 200, winRate: 50, profitFactor: 2.0 },
      NY: { count: 20, pnl: 250, winRate: 55, profitFactor: 2.5 },
      "Off-peak": { count: 0, pnl: 0, winRate: 0, profitFactor: 0 },
    });

    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: analysis,
      moduleContext: makeModuleContext("M1", "breakout"),
    });

    expect(prompt).not.toContain("BREAKOUT SESSION ANOMALY");
  });

  it("M3 uses generic session imbalance check", () => {
    const analysis = makeAnalysis({
      Asia: { count: 20, pnl: 400, winRate: 60, profitFactor: 2.5 },
      London: { count: 20, pnl: 50, winRate: 40, profitFactor: 0.5 },
      NY: { count: 20, pnl: 50, winRate: 40, profitFactor: 0.6 },
      "Off-peak": { count: 0, pnl: 0, winRate: 0, profitFactor: 0 },
    });

    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: analysis,
      moduleContext: makeModuleContext("M3", "pullback"),
    });

    expect(prompt).toContain("SESSION IMBALANCE");
    expect(prompt).not.toContain("MR SESSION");
    expect(prompt).not.toContain("BREAKOUT SESSION");
  });
});

// ---------------------------------------------------------------------------
// Structural diagnostics
// ---------------------------------------------------------------------------

describe("buildOptimizePrompt structural diagnostics", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, ...overrides };
  }

  function makeAnalysisWithExits(exitTypes: Array<{ signal: string; count: number; pnl: number; winRate: number }>): TradeAnalysis {
    const total = exitTypes.reduce((s, e) => s + e.count, 0);
    return {
      totalExitRows: total,
      byDirection: { long: { count: 24, pnl: -15, winRate: 45, profitFactor: 0.8, avgTrade: -0.6 }, short: { count: 53, pnl: -56, winRate: 39, profitFactor: 0.67, avgTrade: -1.06 } },
      bySession: { Asia: { count: 18, pnl: -21, winRate: 33, profitFactor: 0.59 }, London: { count: 9, pnl: -21, winRate: 33, profitFactor: 0.41 }, NY: { count: 47, pnl: -18, winRate: 46, profitFactor: 0.87 }, "Off-peak": { count: 3, pnl: -10, winRate: 33, profitFactor: 0.24 } },
      byExitType: exitTypes,
      byDayOfWeek: { Mon: { count: 16, pnl: -3 }, Sun: { count: 10, pnl: -50 }, Wed: { count: 8, pnl: 20 } },
      best3TradesPnl: [20, 16, 11],
      worst3TradesPnl: [-12, -11, -11],
      avgBarsWinners: 22,
      avgBarsLosers: 21,
      walkForward: null,
    };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 1, maxIter: 10, globalIter: 1,
    paramHistoryPath: "/fake/history.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: {
      moduleId: "M1", moduleName: "Breakout", profile: "breakout",
      signalTF: "15m", regimeTF: "4h", varCap: 8,
      fixedRules: "", stoppingCriteria: "", restructureLocks: "",
      catalog: { slots: [] },
    } as ModuleContext,
  };

  it("flags timeout-dominant exit structure (>60% non-TP/SL)", () => {
    const analysis = makeAnalysisWithExits([
      { signal: "signal", count: 69, pnl: -48, winRate: 42 },
      { signal: "tp1", count: 4, pnl: 23, winRate: 75 },
      { signal: "sl", count: 4, pnl: -47, winRate: 0 },
    ]);
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: analysis });
    expect(prompt).toContain("EXIT STRUCTURE");
    expect(prompt).toContain("89%");
  });

  it("flags day anomaly when one day has >40% of losses", () => {
    const analysis = makeAnalysisWithExits([
      { signal: "signal", count: 34, pnl: -33, winRate: 40 },
    ]);
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: analysis });
    expect(prompt).toContain("DAY ANOMALY");
    expect(prompt).toContain("Sun");
  });

  it("shows R:R ratio warning for symmetric wins/losses", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ avgWinR: 0.51, avgLossR: -0.51 }),
      tradeAnalysis: makeAnalysisWithExits([{ signal: "signal", count: 77, pnl: -70, winRate: 41 }]),
    });
    expect(prompt).toContain("R:R ratio: 1.00");
    expect(prompt).toContain("near-symmetric");
  });

  it("shows day-of-week breakdown in trade analysis", () => {
    const analysis = makeAnalysisWithExits([{ signal: "signal", count: 34, pnl: -33, winRate: 40 }]);
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: analysis });
    expect(prompt).toContain("By day of week:");
    expect(prompt).toContain("Sun");
    expect(prompt).toContain("Wed");
  });

  it("includes failed restructure attempts in the prompt", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      failedRestructures: [
        { globalIter: 18, trades: 1, pf: 0, score: 29.9 },
        { globalIter: 19, trades: 3, pf: 0, score: 17.9 },
      ],
    });
    expect(prompt).toContain("FAILED RESTRUCTURE");
    expect(prompt).toContain("1 trades");
    expect(prompt).toContain("3 trades");
    expect(prompt).toContain("DO NOT repeat");
  });

  it("does not show failures section when list is empty", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      failedRestructures: [],
    });
    expect(prompt).not.toContain("FAILED RESTRUCTURE");
  });

  it("handles metrics with 0 trades gracefully", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ numTrades: 0 }),
      tradeAnalysis: null,
    });
    expect(prompt).toContain("0");
    expect(prompt).not.toContain("undefined");
  });

  it("handles null walkForward in trade analysis", () => {
    const analysis = makeAnalysisWithExits([{ signal: "signal", count: 50, pnl: -30, winRate: 40 }]);
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: { ...analysis, walkForward: null },
    });
    expect(prompt).toBeDefined();
  });
});
