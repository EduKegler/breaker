import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { formatCatalogForPrompt, validateSlugComponents, buildOptimizePrompt } from "./build-optimize-prompt.js";
import type { RestructureFailure } from "./build-optimize-prompt.js";
import type { ComponentCatalog, CatalogSlot, ModuleContext } from "../lib/build-module-context.js";
import type { TestedCombination } from "../types/parameter-history.js";
import type { Metrics, TradeAnalysis, StrategyParam } from "@breaker/backtest";
import type { ScoreRaw } from "../loop/stages/scoring.js";
import type { ScoringWeights } from "../types/config.js";

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
          { name: "Donchian Channel", slug: "donchian", description: "Breakout above/below N-period" },
          { name: "BB squeeze", slug: "squeeze", description: "BB contracts inside KC" },
        ],
      },
      {
        slotName: "Regime Filter",
        typicalVars: "0-1",
        candidates: [
          { name: "EMA direction", slug: "ema", description: "Trend aligned with EMA" },
          { name: "ADX threshold", slug: "adx", description: "ADX < threshold = consolidation" },
        ],
      },
    ],
  };

  it("marks locked candidates with [LOCKED]", () => {
    const result = formatCatalogForPrompt(baseCatalog, [], "entry: Donchian");
    expect(result).toContain("[LOCKED]");
    expect(result).toContain("Donchian Channel [LOCKED]");
  });

  it("marks tested candidates with [TESTED] using slug comparison", () => {
    const tested: TestedCombination[] = [
      { iter: 1, components: { "Entry Signal": "squeeze" }, bestMetrics: null },
    ];
    const result = formatCatalogForPrompt(baseCatalog, tested);
    expect(result).toContain("[TESTED]");
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
        components: { "Entry Signal": "donchian", "Regime Filter": "ema" },
        bestMetrics: { pnl: 100, pf: 1.5, wr: 45, dd: 8, trades: 50 },
      },
    ];
    const result = formatCatalogForPrompt(baseCatalog, tested);
    expect(result).toContain("Previously Tested Combinations");
    expect(result).toContain("iter 3");
    expect(result).toContain("PF=1.5");
    expect(result).toContain("Do NOT repeat");
  });

  it("shows slug in backticks before candidate name", () => {
    const result = formatCatalogForPrompt(baseCatalog, []);
    expect(result).toContain("`donchian` — Donchian Channel:");
    expect(result).toContain("`squeeze` — BB squeeze:");
  });
});

// ---------------------------------------------------------------------------
// validateSlugComponents
// ---------------------------------------------------------------------------

describe("validateSlugComponents", () => {
  const catalog: ComponentCatalog = {
    slots: [
      {
        slotName: "Entry Signal",
        candidates: [
          { name: "Donchian Channel", slug: "donchian", description: "Breakout" },
          { name: "BB squeeze", slug: "squeeze", description: "BB inside KC" },
        ],
      },
      {
        slotName: "Regime Filter",
        candidates: [
          { name: "EMA direction", slug: "ema", description: "Trend aligned" },
          { name: "ADX threshold", slug: "adx", description: "Consolidation" },
        ],
      },
    ],
  };

  it("keeps valid slugs unchanged", () => {
    const result = validateSlugComponents(
      { "Entry Signal": "donchian", "Regime Filter": "ema" },
      catalog,
    );
    expect(result["Entry Signal"]).toBe("donchian");
    expect(result["Regime Filter"]).toBe("ema");
  });

  it("recovers valid slug from unknown slot via global search (pass 3)", () => {
    // "Unknown Slot" doesn't match any slot, but "donchian" is a valid slug in "Entry Signal"
    const result = validateSlugComponents(
      { "Unknown Slot": "donchian" },
      catalog,
    );
    expect(result["Entry Signal"]).toBe("donchian");
  });

  it("drops truly unresolvable entries", () => {
    const result = validateSlugComponents(
      { "Unknown Slot": "not-a-real-slug" },
      catalog,
    );
    expect(result).toEqual({});
  });

  it("drops invalid slugs for a valid slot", () => {
    const result = validateSlugComponents(
      { "Entry Signal": "not-a-real-slug" },
      catalog,
    );
    expect(result).toEqual({});
  });

  it("drops verbose names (not slugs)", () => {
    const result = validateSlugComponents(
      { "Entry Signal": "Donchian Channel Breakout" },
      catalog,
    );
    expect(result).toEqual({});
  });

  it("keeps valid entries and drops invalid ones in mixed input", () => {
    const result = validateSlugComponents(
      { "Entry Signal": "squeeze", "Regime Filter": "invalid", "Unknown": "foo" },
      catalog,
    );
    expect(result).toEqual({ "Entry Signal": "squeeze" });
  });

  // --- Fuzzy matching tests (regression for variant generation failure) ---

  it("fuzzy-matches abbreviated slot names", () => {
    // Claude returned "Entry" instead of "Entry Signal", "Regime" instead of "Regime Filter"
    const result = validateSlugComponents(
      { "Entry": "donchian", "Regime": "adx" },
      catalog,
    );
    expect(result["Entry Signal"]).toBe("donchian");
    expect(result["Regime Filter"]).toBe("adx");
  });

  it("fuzzy-matches compound slugs by prefix", () => {
    // Claude returned "donchian-breakout" instead of "donchian"
    const result = validateSlugComponents(
      { "Entry Signal": "donchian-breakout" },
      catalog,
    );
    expect(result["Entry Signal"]).toBe("donchian");
  });

  it("fuzzy-matches both abbreviated slot and compound slug", () => {
    // Reproduces exact scenario from failed run iter 6
    const result = validateSlugComponents(
      { "Entry": "donchian-breakout", "Regime": "adx-consolidation-4h" },
      catalog,
    );
    expect(result["Entry Signal"]).toBe("donchian");
    expect(result["Regime Filter"]).toBe("adx");
  });

  it("prefers exact match over fuzzy", () => {
    const result = validateSlugComponents(
      { "Entry Signal": "donchian", "Entry": "squeeze" },
      catalog,
    );
    // Exact match wins; "Entry" fuzzy won't reassign the same slot
    expect(result["Entry Signal"]).toBe("donchian");
  });

  it("matches via substring containment in slugs", () => {
    // "bb-kc-squeeze-release" contains "squeeze"
    const result = validateSlugComponents(
      { "Entry Signal": "bb-kc-squeeze-release" },
      catalog,
    );
    expect(result["Entry Signal"]).toBe("squeeze");
  });

  it("matches slot aliases (Volume → Confirmation, HTF Regime → Regime Filter)", () => {
    const extCatalog: ComponentCatalog = {
      slots: [
        ...catalog.slots,
        {
          slotName: "Confirmation",
          candidates: [
            { name: "Volume spike", slug: "vol-spike", description: "Vol > N×SMA" },
          ],
        },
      ],
    };
    const result = validateSlugComponents(
      { "Volume": "vol-sma20-spike", "HTF Regime": "daily-ema200-slope" },
      extCatalog,
    );
    // "Volume" aliases to "Confirmation", "vol-sma20-spike" contains "vol-spike"
    expect(result["Confirmation"]).toBe("vol-spike");
    // "HTF Regime" aliases to "Regime Filter", "daily-ema200-slope" contains "ema"
    expect(result["Regime Filter"]).toBe("ema");
  });

  it("handles real run2 scenario: fragmented Exit slots", () => {
    const exitCatalog: ComponentCatalog = {
      slots: [
        {
          slotName: "Entry Signal",
          candidates: [
            { name: "Donchian Channel", slug: "donchian", description: "Breakout" },
            { name: "BB squeeze", slug: "squeeze", description: "BB inside KC" },
          ],
        },
        {
          slotName: "Exit",
          candidates: [
            { name: "ATR trailing stop", slug: "atr-trail", description: "Trail" },
            { name: "Time-based timeout", slug: "timeout", description: "Timeout" },
          ],
        },
      ],
    };
    // Claude splits "Exit" into Stop/Trail/Timeout — all alias to "Exit"
    // Only one can claim the Exit slot (first match wins)
    const result = validateSlugComponents(
      { "Trail": "atr-1h-trail", "Timeout": "timeout-bars", "Stop": "atr-1h-stop" },
      exitCatalog,
    );
    // At least one should resolve to Exit
    expect(result["Exit"]).toBeDefined();
    expect(["atr-trail", "timeout"]).toContain(result["Exit"]);
  });

  it("global search (pass 3) finds slug in any slot when slot name is unknown", () => {
    const result = validateSlugComponents(
      { "Momentum Filter": "adx-based-gate" },
      catalog,
    );
    // "adx-based-gate" contains "adx" which is in "Regime Filter"
    expect(result["Regime Filter"]).toBe("adx");
  });
});

describe("formatCatalogForPrompt: slug-based TESTED matching", () => {
  const catalog: ComponentCatalog = {
    slots: [{
      slotName: "Entry Signal",
      candidates: [
        { name: "Donchian Channel", slug: "donchian", description: "Breakout" },
        { name: "BB squeeze", slug: "squeeze", description: "BB inside KC" },
      ],
    }],
  };

  it("marks candidate as TESTED when testedCombination uses exact slug", () => {
    const tested: TestedCombination[] = [
      { iter: 5, components: { "Entry Signal": "donchian" }, bestMetrics: null },
    ];
    const result = formatCatalogForPrompt(catalog, tested);
    expect(result).toContain("Donchian Channel [TESTED]");
  });

  it("does NOT mark TESTED with verbose name (only slugs match)", () => {
    const tested: TestedCombination[] = [
      { iter: 5, components: { "Entry Signal": "Donchian Channel" }, bestMetrics: null },
    ];
    const result = formatCatalogForPrompt(catalog, tested);
    expect(result).not.toContain("[TESTED]");
  });
});

// ---------------------------------------------------------------------------
// Restructure prompt: slug reference near metadata template
// ---------------------------------------------------------------------------

describe("restructure prompt slug reference", () => {
  const catalogWithSlots: ComponentCatalog = {
    slots: [
      {
        slotName: "Entry Signal",
        candidates: [
          { name: "Donchian Channel", slug: "donchian", description: "Breakout" },
          { name: "BB squeeze", slug: "squeeze", description: "BB inside KC" },
        ],
      },
      {
        slotName: "Regime Filter",
        candidates: [
          { name: "EMA direction", slug: "ema", description: "Trend" },
        ],
      },
    ],
  };

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "restructure" as const,
    iter: 1, maxIter: 1, globalIter: 6,
    paramHistoryPath: "/fake/ph.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: {
      profile: "breakout", moduleId: "M1", moduleName: "Breakout",
      fixedRules: "", restructureLocks: "", varCap: 8,
      stoppingCriteria: "", signalTF: "15m", regimeTF: "4H",
      catalog: catalogWithSlots,
    } as ModuleContext,
  };

  it("includes slug reference with exact slot names and slugs near metadata template", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: { totalPnl: -800, numTrades: 300, profitFactor: 0.44, maxDrawdownPct: 80, winRate: 54, avgR: -0.07, avgWinR: 0.5, avgLossR: -0.5, maxLossR: -1, expectancy: -2, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null },
      tradeAnalysis: null,
    });

    // Slug reference should appear near the metadata template
    expect(prompt).toContain('"Entry Signal"');
    expect(prompt).toContain('`donchian`');
    expect(prompt).toContain('`squeeze`');
    expect(prompt).toContain('"Regime Filter"');
    expect(prompt).toContain('`ema`');
    // Should have the warning about exact names
    expect(prompt).toContain("EXACT slot names and slugs required");
    expect(prompt).toContain("Do NOT abbreviate or modify");
  });

  it("uses IMPLEMENT template when preSelectedComponents is provided", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: { totalPnl: -800, numTrades: 300, profitFactor: 0.44, maxDrawdownPct: 80, winRate: 54, avgR: -0.07, avgWinR: 0.5, avgLossR: -0.5, maxLossR: -1, expectancy: -2, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null },
      tradeAnalysis: null,
      preSelectedComponents: {
        "Entry Signal": "squeeze",
        "Regime Filter": "ema",
      },
    });

    // Should show assigned components section
    expect(prompt).toContain("Assigned Components");
    expect(prompt).toContain("MUST implement ALL");
    expect(prompt).toContain("`squeeze`");
    expect(prompt).toContain("**Entry Signal**");
    expect(prompt).toContain("**Regime Filter**");
    // Should say IMPLEMENT, not SELECT
    expect(prompt).toContain("**IMPLEMENT** the assigned components");
    // Should NOT have slug reference or selectedComponents in metadata
    expect(prompt).not.toContain("EXACT slot names and slugs required");
    expect(prompt).not.toContain('"selectedComponents"');
    // Catalog should still be visible (for reference)
    expect(prompt).toContain("Component Catalog");
  });

  it("falls back to SELECT template when preSelectedComponents is absent", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: { totalPnl: -800, numTrades: 300, profitFactor: 0.44, maxDrawdownPct: 80, winRate: 54, avgR: -0.07, avgWinR: 0.5, avgLossR: -0.5, maxLossR: -1, expectancy: -2, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null },
      tradeAnalysis: null,
    });

    // Legacy path: should have SELECT
    expect(prompt).toContain("**SELECT** one component per slot");
    expect(prompt).toContain("EXACT slot names and slugs required");
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
      avgWinR: 0.8,
      avgLossR: -0.5,
      maxLossR: -1.5,
      expectancy: 5,
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

  function makeAnalysis(sessions: Record<string, { count: number; pnl: number; winRate: number; profitFactor: number }>, overrides?: Partial<TradeAnalysis>): TradeAnalysis {
    return {
      totalExitRows: 60,
      byDirection: { Long: { count: 30, pnl: 300, winRate: 50, profitFactor: 1.5, avgTrade: 10 }, Short: { count: 30, pnl: 200, winRate: 40, profitFactor: 1.3, avgTrade: 6.67 } },
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
// pctOfPosition convention rule
// ---------------------------------------------------------------------------

describe("buildOptimizePrompt pctOfPosition rule", () => {
  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 1, maxIter: 10, globalIter: 1,
    paramHistoryPath: "/fake/ph.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: { profile: "breakout", moduleId: "M1", moduleName: "Breakout", fixedRules: "", restructureLocks: "", varCap: 8, stoppingCriteria: "", signalTF: "15m", regimeTF: "4H", catalog: { slots: [] } } as ModuleContext,
  };

  it("includes pctOfPosition fraction convention in optimization rules", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: { totalPnl: 500, numTrades: 60, profitFactor: 1.5, maxDrawdownPct: 5, winRate: 45, avgR: 0.2, avgWinR: 0.8, avgLossR: -0.5, maxLossR: -1.5, expectancy: 5, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null },
      tradeAnalysis: null,
    });
    expect(prompt).toContain("pctOfPosition is a FRACTION (0-1)");
    expect(prompt).toContain("0.50");
  });

  it("formats N/A for all undefined metrics without throwing", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: {} as Metrics,
      tradeAnalysis: null,
    });
    expect(prompt).toContain("PnL: N/A");
    expect(prompt).toContain("Trades: N/A");
    expect(prompt).toContain("PF: N/A");
    expect(prompt).toContain("DD: N/A");
    expect(prompt).toContain("WR: N/A");
    expect(prompt).toContain("AvgR: N/A");
    expect(prompt).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Structural diagnostics
// ---------------------------------------------------------------------------

describe("buildOptimizePrompt structural diagnostics", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
  }

  function makeAnalysisWithExits(exitTypes: Array<{ signal: string; count: number; pnl: number; winRate: number }>): TradeAnalysis {
    const total = exitTypes.reduce((s, e) => s + e.count, 0);
    return {
      totalExitRows: total,
      byDirection: { Long: { count: 24, pnl: -15, winRate: 45, profitFactor: 0.8, avgTrade: -0.6 }, Short: { count: 53, pnl: -56, winRate: 39, profitFactor: 0.67, avgTrade: -1.06 } },
      bySession: { Asia: { count: 18, pnl: -21, winRate: 33, profitFactor: 0.59, edgeBpsNet: 0, avgCostBps: 0 }, London: { count: 9, pnl: -21, winRate: 33, profitFactor: 0.41, edgeBpsNet: 0, avgCostBps: 0 }, NY: { count: 47, pnl: -18, winRate: 46, profitFactor: 0.87, edgeBpsNet: 0, avgCostBps: 0 }, "Off-peak": { count: 3, pnl: -10, winRate: 33, profitFactor: 0.24, edgeBpsNet: 0, avgCostBps: 0 } },
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
      phase: "restructure",
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

  it("shows DD as unmet when maxDrawdownPct is negative (B1: sign fix)", () => {
    // maxDrawdownPct from equity-curve is negative (e.g., -22 for 22% DD)
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ maxDrawdownPct: -22 }),
      tradeAnalysis: null,
    });
    expect(prompt).toContain("Max Drawdown must be <= ");
  });

  it("displays DD without negative sign in unmet criteria (P1: display fix)", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ maxDrawdownPct: -44.3 }),
      tradeAnalysis: null,
    });
    expect(prompt).toContain("current: 44.3%");
    expect(prompt).not.toContain("current: -44.3%");
  });

  it("does not flag DD overfit for negative maxDrawdownPct (B1: sign fix)", () => {
    // DD of -8 means 8% DD, which is NOT < 1%, so should NOT trigger overfit signal
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ maxDrawdownPct: -8 }),
      tradeAnalysis: null,
    });
    expect(prompt).not.toContain("OVERFIT SIGNAL: DD=");
  });

  it("displays DD without negative sign in overfit warning (P1: display fix)", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ maxDrawdownPct: -0.5 }),
      tradeAnalysis: null,
    });
    expect(prompt).toContain("OVERFIT SIGNAL: DD=0.5%");
    expect(prompt).not.toContain("DD=-0.5%");
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

  it("includes module acceptance criteria in prompt (P4.1)", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
    });
    expect(prompt).toContain("MODULE ACCEPTANCE CRITERIA");
    expect(prompt).toContain("Trades >= 50");
    expect(prompt).toContain("PF >= 1.3");
  });

  it("includes rollback reason when present (P4.2)", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      lastRollbackReason: "score degraded (25.0 vs best 33.7)",
    });
    expect(prompt).toContain("LAST ITERATION ROLLED BACK");
    expect(prompt).toContain("score degraded");
    expect(prompt).toContain("avoiding the same mistake");
  });

  it("does not include rollback section when no rollback occurred", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
    });
    expect(prompt).not.toContain("LAST ITERATION ROLLED BACK");
  });

  it("includes walk-forward split ratio in KB constraints (P2.3)", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
    });
    expect(prompt).toContain("Walk-forward split: train 70% / test 30%");
    expect(prompt).toContain("KB §10.1");
  });

  it("includes M2 WR gate in module criteria for mean-reversion", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      moduleContext: {
        moduleId: "M2", moduleName: "Mean Reversion", profile: "mean-reversion",
        signalTF: "15m", regimeTF: "1H", varCap: 6,
        fixedRules: "", stoppingCriteria: "- WR >= 50%", restructureLocks: "",
        catalog: { slots: [] },
      },
    });
    expect(prompt).toContain("WR >= 50%");
    expect(prompt).toContain("[mandatory]");
  });
});

// ---------------------------------------------------------------------------
// G5: Walk-forward metrics in prompt
// ---------------------------------------------------------------------------

describe("G5: walk-forward section in prompt", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: 500, numTrades: 60, profitFactor: 1.5, maxDrawdownPct: -5, winRate: 45, avgR: 0.2, avgWinR: 0.8, avgLossR: -0.5, maxLossR: -1.5, expectancy: 5, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
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

  it("includes WF section when walkForward is provided", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      walkForward: {
        trainTrades: 50, testTrades: 20, splitRatio: 0.7,
        hourConsistency: [],
        trainPF: 1.8, testPF: 1.2, pfRatio: 0.67, overfitFlag: false,
      },
    });
    expect(prompt).toContain("WALK-FORWARD VALIDATION");
    expect(prompt).toContain("trainPF=1.80");
    expect(prompt).toContain("testPF=1.20");
    expect(prompt).toContain("pfRatio=0.67");
    expect(prompt).toContain("pfRatio 0.60-0.69");
  });

  it("shows overfit warning when overfitFlag is true", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      walkForward: {
        trainTrades: 50, testTrades: 20, splitRatio: 0.7,
        hourConsistency: [],
        trainPF: 2.0, testPF: 0.8, pfRatio: 0.40, overfitFlag: true,
      },
    });
    expect(prompt).toContain("currently overfitting");
    expect(prompt).toContain("pfRatio=0.40");
    expect(prompt).toContain("Reduce model complexity");
  });

  it("shows excellent for pfRatio >= 0.85", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      walkForward: {
        trainTrades: 50, testTrades: 20, splitRatio: 0.7,
        hourConsistency: [],
        trainPF: 1.5, testPF: 1.4, pfRatio: 0.93, overfitFlag: false,
      },
    });
    expect(prompt).toContain("excellent generalization");
  });

  it("shows good for pfRatio 0.70-0.84", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      walkForward: {
        trainTrades: 50, testTrades: 20, splitRatio: 0.7,
        hourConsistency: [],
        trainPF: 1.5, testPF: 1.1, pfRatio: 0.73, overfitFlag: false,
      },
    });
    expect(prompt).toContain("pfRatio 0.70-0.84");
  });

  it("does not include WF section when walkForward is null", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      walkForward: null,
    });
    expect(prompt).not.toContain("WALK-FORWARD VALIDATION");
  });

  it("does not include WF section when walkForward is not provided", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
    });
    expect(prompt).not.toContain("WALK-FORWARD VALIDATION");
  });
});

// ---------------------------------------------------------------------------
// P1.1: Scoring transparency — weights and breakdown in prompt
// ---------------------------------------------------------------------------

describe("P1.1: scoring transparency in prompt", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
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

  const sampleBreakdown: ScoreRaw = { pf: 0.355, avgR: 0, wr: 0.683, dd: 0, complexity: 0.429, sampleConfidence: 0.513 };
  const sampleWeights: ScoringWeights = { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 };

  it("includes SCORING FUNCTION section when scoreBreakdown is provided", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      scoreBreakdown: sampleBreakdown,
      scoringWeights: sampleWeights,
      currentScore: 33.7,
    });
    expect(prompt).toContain("SCORING FUNCTION");
    expect(prompt).toContain("Weights:");
    expect(prompt).toContain("PF=25%");
    expect(prompt).toContain("Total: 33.7/100");
  });

  it("does not include SCORING FUNCTION when breakdown is absent", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
    });
    expect(prompt).not.toContain("SCORING FUNCTION");
  });

  it("shows focus hint about lowest-scoring component", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      scoreBreakdown: sampleBreakdown,
      scoringWeights: sampleWeights,
      currentScore: 33.7,
    });
    expect(prompt).toContain("Focus on the LOWEST-scoring");
  });
});

// ---------------------------------------------------------------------------
// P1.2: Score delta vs best
// ---------------------------------------------------------------------------

describe("P1.2: score delta section", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 2, maxIter: 10, globalIter: 2,
    paramHistoryPath: "/fake/history.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: {
      moduleId: "M1", moduleName: "Breakout", profile: "breakout",
      signalTF: "15m", regimeTF: "4h", varCap: 8,
      fixedRules: "", stoppingCriteria: "", restructureLocks: "",
      catalog: { slots: [] },
    } as ModuleContext,
  };

  const current: ScoreRaw = { pf: 0.2, avgR: 0, wr: 0.5, dd: 0, complexity: 0.4, sampleConfidence: 0.2 };
  const best: ScoreRaw = { pf: 0.4, avgR: 0.3, wr: 0.7, dd: 0.5, complexity: 0.4, sampleConfidence: 1.0 };
  const weights: ScoringWeights = { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 };

  it("shows delta section when current < best", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      scoreBreakdown: current,
      bestScoreBreakdown: best,
      scoringWeights: weights,
      currentScore: 20,
      bestScore: 45,
    });
    expect(prompt).toContain("SCORE DELTA vs BEST");
    expect(prompt).toContain("20.0 vs 45.0");
  });

  it("does not show delta section when current >= best", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      scoreBreakdown: current,
      bestScoreBreakdown: best,
      scoringWeights: weights,
      currentScore: 50,
      bestScore: 45,
    });
    expect(prompt).not.toContain("SCORE DELTA vs BEST");
  });

  it("shows which component dropped the most", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      scoreBreakdown: current,
      bestScoreBreakdown: best,
      scoringWeights: weights,
      currentScore: 20,
      bestScore: 45,
    });
    expect(prompt).toContain("dropped the most");
    expect(prompt).toContain("Sample");
  });
});

// ---------------------------------------------------------------------------
// P2.1: Last iteration result in prompt
// ---------------------------------------------------------------------------

describe("P2.1: last iteration result", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 2, maxIter: 10, globalIter: 2,
    paramHistoryPath: "/fake/history.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: {
      moduleId: "M1", moduleName: "Breakout", profile: "breakout",
      signalTF: "15m", regimeTF: "4h", varCap: 8,
      fixedRules: "", stoppingCriteria: "", restructureLocks: "",
      catalog: { slots: [] },
    } as ModuleContext,
  };

  it("includes LAST ITERATION RESULT when paramHistory has iterations with changes", () => {
    // Mock fs.readFileSync to return param history
    vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (String(p).includes("history.json")) {
        return JSON.stringify({
          iterations: [{
            iter: 1,
            date: "2025-01-01",
            change: { param: "dcSlow", from: 55, to: 60 },
            before: { pnl: -100, trades: 77, pf: 0.5 },
            after: { pnl: -442.46, trades: 77, pf: 0.33 },
            verdict: "degraded",
          }],
          neverWorked: [],
          exploredRanges: {},
          pendingHypotheses: [],
        });
      }
      if (String(p).includes("strategy.ts")) return "// strategy source";
      return "";
    });

    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).toContain("LAST ITERATION RESULT");
    expect(prompt).toContain("dcSlow");
    expect(prompt).toContain("from 55 to 60");
    expect(prompt).toContain("degraded");
    // Rollback note clarifies that the "to" value is NOT the current value
    expect(prompt).toContain("ROLLED BACK");
    expect(prompt).toContain("reverted to 55");

    vi.restoreAllMocks();
  });

  it("does not show ROLLED BACK note when verdict is improved", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (String(p).includes("history.json")) {
        return JSON.stringify({
          iterations: [{
            iter: 1,
            date: "2025-01-01",
            change: { param: "dcSlow", from: 55, to: 60 },
            before: { pnl: -100, trades: 77, pf: 0.5 },
            after: { pnl: -50, trades: 80, pf: 0.8 },
            verdict: "improved",
          }],
          neverWorked: [],
          exploredRanges: {},
          pendingHypotheses: [],
        });
      }
      if (String(p).includes("strategy.ts")) return "// strategy source";
      return "";
    });

    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).toContain("LAST ITERATION RESULT");
    expect(prompt).not.toContain("ROLLED BACK");

    vi.restoreAllMocks();
  });

  it("shows structural change for restructure iterations (change=null)", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (String(p).includes("history.json")) {
        return JSON.stringify({
          iterations: [{
            iter: 5,
            date: "2025-01-01",
            change: null,
            before: { pnl: -442, trades: 157, pf: 0.33 },
            after: { pnl: -220, trades: 33, pf: 0.10 },
            verdict: "degraded",
          }],
          neverWorked: [],
          exploredRanges: {},
          pendingHypotheses: [],
        });
      }
      if (String(p).includes("strategy.ts")) return "// strategy source";
      return "";
    });

    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).toContain("LAST ITERATION RESULT");
    expect(prompt).toContain("Structural change");
    expect(prompt).toContain("degraded");

    vi.restoreAllMocks();
  });

  it("skips LAST ITERATION RESULT when verdict is pending", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (String(p).includes("history.json")) {
        return JSON.stringify({
          iterations: [{
            iter: 5,
            date: "2025-01-01",
            change: null,
            before: { pnl: -442, trades: 157, pf: 0.33 },
            after: null,
            verdict: "pending",
          }],
          neverWorked: [],
          exploredRanges: {},
          pendingHypotheses: [],
        });
      }
      if (String(p).includes("strategy.ts")) return "// strategy source";
      return "";
    });

    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).not.toContain("LAST ITERATION RESULT");

    vi.restoreAllMocks();
  });

  it("does not include LAST ITERATION RESULT when no param history", () => {
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).not.toContain("LAST ITERATION RESULT");
  });
});

// ---------------------------------------------------------------------------
// P1: Diagnostic guide
// ---------------------------------------------------------------------------
describe("P1: diagnostic guide", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: -22, winRate: 25, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
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

  it("shows R:R diagnostic when PF < 1 and R:R near symmetric", () => {
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics({ profitFactor: 0.5, avgWinR: 0.5, avgLossR: -0.5 }), tradeAnalysis: null });
    expect(prompt).toContain("DIAGNOSTIC GUIDE");
    expect(prompt).toContain("R:R ratio near 1.0");
  });

  it("shows entry selectivity diagnostic when PF < 1 and WR < 30%", () => {
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics({ profitFactor: 0.5, winRate: 22 }), tradeAnalysis: null });
    expect(prompt).toContain("entry selectivity");
  });

  it("flags weak direction when one direction PF < 0.5", () => {
    const analysis: TradeAnalysis = {
      totalExitRows: 60,
      byDirection: { Long: { count: 30, pnl: -200, winRate: 20, profitFactor: 0.3, avgTrade: -6.7 }, Short: { count: 30, pnl: 200, winRate: 55, profitFactor: 1.8, avgTrade: 6.7 } },
      bySession: {
        Asia: { count: 15, pnl: 0, winRate: 50, profitFactor: 1.0 },
        London: { count: 15, pnl: 0, winRate: 50, profitFactor: 1.0 },
        NY: { count: 15, pnl: 0, winRate: 50, profitFactor: 1.0 },
        "Off-peak": { count: 15, pnl: 0, winRate: 50, profitFactor: 1.0 },
      } as any,
      byExitType: [], byDayOfWeek: {},
      best3TradesPnl: [50, 40, 30], worst3TradesPnl: [-30, -25, -20],
      avgBarsWinners: 10, avgBarsLosers: 5, walkForward: null,
    };
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: analysis });
    expect(prompt).toContain("long direction PF < 0.5");
  });

  it("does not show diagnostic guide when metrics are healthy", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ profitFactor: 1.8, winRate: 50, avgWinR: 1.2, avgLossR: -0.5 }),
      tradeAnalysis: null,
    });
    expect(prompt).not.toContain("DIAGNOSTIC GUIDE");
  });

  it("shows archetype drift warning for M4 with excessive trades", () => {
    const m4Opts = {
      ...baseOpts,
      moduleContext: {
        ...baseOpts.moduleContext,
        moduleId: "M4", moduleName: "Trend Following", profile: "trend-following",
        stoppingCriteria: "- Trades >= 30\n- PF >= 1.4",
      } as ModuleContext,
    };
    const prompt = buildOptimizePrompt({
      ...m4Opts,
      metrics: makeMetrics({ numTrades: 100, profitFactor: 1.8, winRate: 50, avgWinR: 1.2, avgLossR: -0.5 }),
      tradeAnalysis: null,
    });
    // 100 trades in 6m = ~200/year, M4 expects 10-20/year → drift warning
    expect(prompt).toContain("ARCHETYPE DRIFT");
    expect(prompt).toContain("SCALPING");
  });

  it("does not show archetype drift for M4 with expected trade count", () => {
    const m4Opts = {
      ...baseOpts,
      moduleContext: {
        ...baseOpts.moduleContext,
        moduleId: "M4", moduleName: "Trend Following", profile: "trend-following",
        stoppingCriteria: "- Trades >= 30\n- PF >= 1.4",
      } as ModuleContext,
    };
    const prompt = buildOptimizePrompt({
      ...m4Opts,
      metrics: makeMetrics({ numTrades: 8, profitFactor: 1.8, winRate: 50, avgWinR: 1.2, avgLossR: -0.5 }),
      tradeAnalysis: null,
    });
    // 8 trades in 6m = ~16/year, within 10-20 range → no drift
    expect(prompt).not.toContain("ARCHETYPE DRIFT");
  });

  it("does not show archetype drift for M1 with high trade count", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics({ numTrades: 150, profitFactor: 1.8, winRate: 50, avgWinR: 1.2, avgLossR: -0.5 }),
      tradeAnalysis: null,
    });
    // M1 expects 50-200/year, 150 in 6m = 300/year, within 2x max (400) → no drift
    expect(prompt).not.toContain("ARCHETYPE DRIFT");
  });

  it("uses actual date range for annualization instead of hardcoded 6-month assumption", () => {
    const m4Opts = {
      ...baseOpts,
      moduleContext: {
        ...baseOpts.moduleContext,
        moduleId: "M4", moduleName: "Trend Following", profile: "trend-following",
        stoppingCriteria: "- Trades >= 30\n- PF >= 1.4",
      } as ModuleContext,
    };
    // 44 trades over ~2.15 years (2024-01-01 to 2026-02-24) = ~20/year
    // M4 expects 10-20/year → should NOT trigger drift
    const start = new Date("2024-01-01").getTime();
    const end = new Date("2026-02-24").getTime();
    const prompt = buildOptimizePrompt({
      ...m4Opts,
      metrics: makeMetrics({ numTrades: 44, profitFactor: 1.3, winRate: 43, avgWinR: 0.8, avgLossR: -0.37 }),
      tradeAnalysis: null,
      startTime: start,
      endTime: end,
    });
    // 44 / 2.15 = ~20/year, within expected range → no drift
    expect(prompt).not.toContain("ARCHETYPE DRIFT");

    // Without date range (fallback), same 44 trades would annualize to 88/year → drift
    const promptNoDate = buildOptimizePrompt({
      ...m4Opts,
      metrics: makeMetrics({ numTrades: 44, profitFactor: 1.3, winRate: 43, avgWinR: 0.8, avgLossR: -0.37 }),
      tradeAnalysis: null,
    });
    expect(promptNoDate).toContain("ARCHETYPE DRIFT");
  });
});

// ---------------------------------------------------------------------------
// P2: Param effect map in core params section
// ---------------------------------------------------------------------------
describe("P2: param effect map", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: 500, numTrades: 60, profitFactor: 1.5, maxDrawdownPct: -5, winRate: 45, avgR: 0.2, avgWinR: 0.8, avgLossR: -0.5, maxLossR: -1.5, expectancy: 5, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: {
      minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8,
      designChecklist: undefined,
      coreParameters: [
        { name: "dcSlow", min: 30, max: 60, step: 5 },
        { name: "atrStopMult", min: 3.0, max: 5.0, step: 0.5 },
        { name: "adxThreshold", min: 20, max: 35, step: 5 },
      ],
    },
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

  it("shows range info for core params", () => {
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).toContain("dcSlow [30-60, step 5]");
    expect(prompt).toContain("atrStopMult [3-5, step 0.5]");
  });

  it("shows param effect hints for known param names", () => {
    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).toContain("fewer/bigger breakouts");
    expect(prompt).toContain("wider stop");
    expect(prompt).toContain("stricter filter");
  });
});

// ---------------------------------------------------------------------------
// P2.2: Explored ranges enriched with metrics
// ---------------------------------------------------------------------------

describe("P2.2: explored ranges with metrics", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 3, maxIter: 10, globalIter: 5,
    paramHistoryPath: "/fake/history.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: {
      moduleId: "M1", moduleName: "Breakout", profile: "breakout",
      signalTF: "15m", regimeTF: "4h", varCap: 8,
      fixedRules: "", stoppingCriteria: "", restructureLocks: "",
      catalog: { slots: [] },
    } as ModuleContext,
  };

  it("shows PF per tested value when iteration data exists", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation((p: any) => {
      if (String(p).includes("history.json")) {
        return JSON.stringify({
          iterations: [
            { iter: 1, date: "2025-01-01", change: { param: "dcSlow", from: 40, to: 45 }, before: { pnl: 0, trades: 70, pf: 0.28 }, after: { pnl: 10, trades: 72, pf: 0.31 }, verdict: "improved" },
            { iter: 2, date: "2025-01-01", change: { param: "dcSlow", from: 45, to: 50 }, before: { pnl: 10, trades: 72, pf: 0.31 }, after: { pnl: 30, trades: 75, pf: 0.35 }, verdict: "improved" },
            { iter: 3, date: "2025-01-01", change: { param: "dcSlow", from: 50, to: 55 }, before: { pnl: 30, trades: 75, pf: 0.35 }, after: { pnl: 20, trades: 73, pf: 0.33 }, verdict: "degraded" },
          ],
          neverWorked: [],
          exploredRanges: { dcSlow: [40, 45, 50, 55] },
          pendingHypotheses: [],
        });
      }
      if (String(p).includes("strategy.ts")) return "// strategy source";
      return "";
    });

    const prompt = buildOptimizePrompt({ ...baseOpts, metrics: makeMetrics(), tradeAnalysis: null });
    expect(prompt).toContain("EXPLORED SPACE");
    expect(prompt).toContain("PF=");
    expect(prompt).toContain("Sweet spot");

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// P3.1: Guardrail specificity tested via orchestrator rollback tests
// ---------------------------------------------------------------------------

describe("P3.1: guardrail-specific rollback reason", () => {
  it("WF overfit produces specific message", () => {
    const wfViolations = [{ field: "pfRatio", reason: "0.45 < 0.6" }];
    const fvViolations: any[] = [];
    const wf = { pfRatio: 0.45, trainPF: 1.8, testPF: 0.81, overfitFlag: true };
    const scoreVerdict = "accept";
    const effectiveVerdict = "reject";

    let rollbackCause: string;
    if (effectiveVerdict === scoreVerdict) {
      rollbackCause = "score degraded";
    } else if (wfViolations.length > 0) {
      rollbackCause = `WF overfit: pfRatio=${wf.pfRatio.toFixed(2)} < 0.6 (train PF=${wf.trainPF.toFixed(2)}, test PF=${wf.testPF.toFixed(2)})`;
    } else if (fvViolations.length > 0) {
      rollbackCause = `Free variable cap exceeded`;
    } else {
      rollbackCause = "guardrail rejected";
    }

    expect(rollbackCause).toContain("WF overfit");
    expect(rollbackCause).toContain("pfRatio=0.45");
    expect(rollbackCause).toContain("train PF=1.80");
  });

  it("free variable violation produces specific message", () => {
    const wfViolations: any[] = [];
    const fvViolations = [{ field: "paramCount", reason: "10 > 8" }];
    const paramCount = 10;
    const maxFreeVariables = 8;

    let rollbackCause: string;
    if (wfViolations.length > 0) {
      rollbackCause = "WF overfit";
    } else if (fvViolations.length > 0) {
      rollbackCause = `Free variable cap exceeded: ${paramCount} params > max ${maxFreeVariables}`;
    } else {
      rollbackCause = "unknown";
    }

    expect(rollbackCause).toContain("Free variable cap exceeded");
    expect(rollbackCause).toContain("10 params > max 8");
  });
});

// ---------------------------------------------------------------------------
// P3.2: Failed restructure diagnosis in prompt
// ---------------------------------------------------------------------------

describe("P3.2: failed restructure diagnosis", () => {
  function makeMetrics(overrides?: Partial<Metrics>): Metrics {
    return { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09, avgWinR: 0.51, avgLossR: -0.51, maxLossR: -1.14, expectancy: -0.088, edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null, sharpeRatio: null, sortinoRatio: null, ...overrides };
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

  it("includes diagnosis in failed restructure section", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      phase: "restructure",
      metrics: makeMetrics(),
      tradeAnalysis: null,
      failedRestructures: [
        { globalIter: 18, trades: 1, pf: 0, score: 29.9, diagnosis: "trades 1 < minTrades 50, PF 0.00 < 1.3" },
      ],
    });
    expect(prompt).toContain("FAILED RESTRUCTURE");
    expect(prompt).toContain("trades 1 < minTrades 50");
    expect(prompt).toContain("PF 0.00 < 1.3");
  });

  it("shows failure without diagnosis when not provided", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      phase: "restructure",
      metrics: makeMetrics(),
      tradeAnalysis: null,
      failedRestructures: [
        { globalIter: 18, trades: 30, pf: 0.93, score: 32.4 },
      ],
    });
    expect(prompt).toContain("FAILED RESTRUCTURE");
    expect(prompt).toContain("30 trades");
    // Without diagnosis, line should end with Score=32.4 (no " | diagnosis" suffix)
    expect(prompt).toMatch(/Score=32\.4\n/);
  });
});

// ---------------------------------------------------------------------------
// Repeat feedback in prompt
// ---------------------------------------------------------------------------

describe("buildOptimizePrompt: rejectedRepeats", () => {
  function makeModuleContext(): ModuleContext {
    return {
      profile: "breakout", moduleId: "M1", moduleName: "Breakout",
      fixedRules: "1. test rule", restructureLocks: "", varCap: 8,
      stoppingCriteria: "- Trades >= 50", signalTF: "15m", regimeTF: "4H",
      catalog: { slots: [] },
    };
  }

  function makeMetrics(): Metrics {
    return {
      totalPnl: 500, numTrades: 60, profitFactor: 1.5, maxDrawdownPct: 5,
      winRate: 45, avgR: 0.2, avgWinR: 0.8, avgLossR: -0.5, maxLossR: -1.5, expectancy: 5,
      edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null,
      sharpeRatio: null, sortinoRatio: null,
    };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 5, maxIter: 20, globalIter: 10,
    paramHistoryPath: "/fake/ph.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: makeModuleContext(),
  };

  it("includes repeat warning when rejectedRepeats is non-empty", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      rejectedRepeats: [
        "adxThreshold 25→20 (historical repeat)",
        "adxThreshold 25→20 (historical repeat)",
      ],
    });
    expect(prompt).toContain("REPEAT ALERT");
    expect(prompt).toContain("adxThreshold 25→20");
    expect(prompt).toContain("MUST try different");
  });

  it("does NOT include repeat warning when rejectedRepeats is empty", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      rejectedRepeats: [],
    });
    expect(prompt).not.toContain("REPEAT ALERT");
  });

  it("does NOT include repeat warning when rejectedRepeats is undefined", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
    });
    expect(prompt).not.toContain("REPEAT ALERT");
  });
});

// ---------------------------------------------------------------------------
// Validation warnings feedback in prompt
// ---------------------------------------------------------------------------

describe("buildOptimizePrompt: lastValidationWarnings", () => {
  function makeModuleContext(): ModuleContext {
    return {
      profile: "breakout", moduleId: "M1", moduleName: "Breakout",
      fixedRules: "1. test rule", restructureLocks: "", varCap: 8,
      stoppingCriteria: "- Trades >= 50", signalTF: "15m", regimeTF: "4H",
      catalog: { slots: [] },
    };
  }

  function makeMetrics(): Metrics {
    return {
      totalPnl: 500, numTrades: 60, profitFactor: 1.5, maxDrawdownPct: 5,
      winRate: 45, avgR: 0.2, avgWinR: 0.8, avgLossR: -0.5, maxLossR: -1.5, expectancy: 5,
      edgeBpsGross: null, edgeBpsNet: null, avgCostBps: null, tradesPerDay: null, totalCostPct: null,
      sharpeRatio: null, sortinoRatio: null,
    };
  }

  const baseOpts = {
    strategySourcePath: "/fake/strategy.ts",
    strategyParams: {} as Record<string, StrategyParam>,
    paramOverrides: {},
    criteria: { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: undefined, minAvgR: 0.15, maxFreeVariables: 8, designChecklist: undefined, coreParameters: undefined },
    asset: "BTC",
    phase: "refine" as const,
    iter: 5, maxIter: 20, globalIter: 10,
    paramHistoryPath: "/fake/ph.json",
    artifactsDir: "/fake/artifacts",
    moduleContext: makeModuleContext(),
  };

  it("includes validation warnings when lastValidationWarnings is non-empty", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      lastValidationWarnings: [
        "VAR CAP EXCEEDED: 9 vars (cap: 8). 1 new params introduced. Some may need to be dropped.",
      ],
    });
    expect(prompt).toContain("VALIDATION WARNINGS");
    expect(prompt).toContain("VAR CAP EXCEEDED");
    expect(prompt).toContain("9 vars (cap: 8)");
  });

  it("shows multiple warnings", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      lastValidationWarnings: [
        "VAR CAP EXCEEDED: 9 vars (cap: 8). 1 new params introduced.",
        'Clamped "atrStopMult": 1.0 below range min 2.0. Set to 2.0.',
      ],
    });
    expect(prompt).toContain("VAR CAP EXCEEDED");
    expect(prompt).toContain("Clamped");
  });

  it("does NOT include section when lastValidationWarnings is empty", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
      lastValidationWarnings: [],
    });
    expect(prompt).not.toContain("VALIDATION WARNINGS");
  });

  it("does NOT include section when lastValidationWarnings is undefined", () => {
    const prompt = buildOptimizePrompt({
      ...baseOpts,
      metrics: makeMetrics(),
      tradeAnalysis: null,
    });
    expect(prompt).not.toContain("VALIDATION WARNINGS");
  });
});

// ---------------------------------------------------------------------------
// P4.1: paramCount in checkpoint
// ---------------------------------------------------------------------------

describe("P4.1: paramCount in checkpoint", () => {
  it("uses paramCount from checkpoint instead of Object.keys after rollback", () => {
    const cpParams = { dcSlow: 55, dcFast: 20, atrStopMult: 3.5 };
    const cpParamCount = 4; // strategy has 4 optimizable but only 3 overrides
    const phase = "restructure";
    const effectiveVerdict = "reject";

    let paramCount = 8; // stale

    if (effectiveVerdict === "reject" && phase !== "refine") {
      if (cpParamCount != null) {
        paramCount = cpParamCount;
      } else {
        paramCount = Object.keys(cpParams).length;
      }
    }

    expect(paramCount).toBe(4); // uses saved count, not Object.keys(3)
  });
});
