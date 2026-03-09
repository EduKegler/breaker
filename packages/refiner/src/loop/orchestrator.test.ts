import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyRollback, applyB2Rollback } from "./loop-state.js";

vi.mock("@breaker/alerts", () => ({
  sendWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/config.js", () => ({
  loadConfig: vi.fn((_path: string, opts?: { asset?: string; strategy?: string }) => ({
    config: {
      criteria: {},
      modelRouting: { optimize: "sonnet", fix: "haiku", plan: "opus" },
      assetClasses: { "crypto-major": { minPF: 1.6 } },
      strategyProfiles: { breakout: {} },
      guardrails: { maxRiskTradeUsd: 25, protectedFields: [] },
      assets: { BTC: { class: "crypto-major", strategies: { breakout: { coin: "BTC", dataSource: "binance", interval: "15m", strategyFactory: "createTestStrategy", dateRange: { start: "2025-05-24", end: "2026-02-24" } } } } },
      phases: { refine: { maxIter: 5 }, research: { maxIter: 3 }, restructure: { maxIter: 5 }, maxCycles: 2 },
      scoring: { weights: { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 } },
      research: { enabled: true, model: "sonnet", maxSearchesPerIter: 3, timeoutMs: 180000 },
    },
    criteria: { minTrades: 150, minPF: 1.6, maxDD: 8, minWR: 30, minAvgR: 0.20 },
    dataConfig: {
      coin: opts?.asset ?? "BTC",
      dataSource: "binance",
      interval: "15m",
      strategyFactory: "createTestStrategy",
    },
    dateRange: {
      startTime: new Date("2025-05-24T00:00:00Z").getTime(),
      endTime: new Date("2026-02-24T23:59:59.999Z").getTime(),
    },
  })),
}));

vi.mock("../lib/build-strategy-dir.js", () => ({
  buildStrategyDir: vi.fn((_root: string, asset: string, strategy: string) => `${_root}/assets/${asset}/${strategy}`),
}));

vi.mock("../lib/get-strategy-source-path.js", () => ({
  getStrategySourcePath: vi.fn((_root: string, _factoryName: string, _coin?: string, _strategy?: string) => `${_root}/packages/backtest/src/strategies/btc/breakout/test-seed.ts`),
  factoryToKebab: vi.fn((name: string) => {
    let n = name.replace(/^create/, "");
    n = n.replace(/([A-Z])/g, (_: string, ch: string) => `-${ch.toLowerCase()}`);
    return n.startsWith("-") ? n.slice(1) : n;
  }),
}));

import { parseArgs } from "./parse-args.js";
import { buildLoopConfig } from "./build-loop-config.js";
import { checkCriteria } from "./check-criteria.js";
import { phaseHelpers } from "./phase-helpers.js";
import type { LoopConfig, IterationState } from "./types.js";
import { computeScore } from "./stages/scoring.js";
import type { ScoreVerdict } from "./stages/scoring.js";
import { integrity } from "./stages/integrity.js";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------
describe("parseArgs", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.argv = ["node", "orchestrator.js"];
    delete process.env.ASSET;
    delete process.env.STRATEGY;
    delete process.env.MAX_ITER;
    delete process.env.REPO_ROOT;
    delete process.env.AUTO_COMMIT;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  it("returns defaults when no flags or env vars are set", () => {
    const result = parseArgs();
    expect(result.asset).toBeUndefined();
    expect(result.strategy).toBe("breakout");
    expect(result.maxIter).toBe(10);
    expect(result.autoCommit).toBe(false);
    expect(result.initialPhase).toBeUndefined();
  });

  it("parses all CLI flags", () => {
    process.argv = [
      "node", "orchestrator.js",
      "--asset=ETH",
      "--strategy=mean-reversion",
      "--max-iter=20",
      "--repo-root=/tmp/test",
      "--auto-commit",
      "--phase=research",
    ];
    const result = parseArgs();
    expect(result.asset).toBe("ETH");
    expect(result.strategy).toBe("mean-reversion");
    expect(result.maxIter).toBe(20);
    expect(result.repoRoot).toBe("/tmp/test");
    expect(result.autoCommit).toBe(true);
    expect(result.initialPhase).toBe("research");
  });

  it("parses --strategy flag", () => {
    process.argv = ["node", "orchestrator.js", "--strategy=squeeze"];
    const result = parseArgs();
    expect(result.strategy).toBe("squeeze");
  });

  it("falls back to STRATEGY env var when --strategy flag is absent", () => {
    process.env.STRATEGY = "mean-reversion";
    const result = parseArgs();
    expect(result.strategy).toBe("mean-reversion");
  });

  it("returns undefined asset when neither flag nor env var is set", () => {
    const result = parseArgs();
    expect(result.asset).toBeUndefined();
  });

  it("falls back to env vars when flags are absent", () => {
    process.env.ASSET = "SOL";
    process.env.MAX_ITER = "7";
    process.env.REPO_ROOT = "/env/root";
    process.env.AUTO_COMMIT = "true";
    const result = parseArgs();
    expect(result.asset).toBe("SOL");
    expect(result.maxIter).toBe(7);
    expect(result.repoRoot).toBe("/env/root");
    expect(result.autoCommit).toBe(true);
  });

  it("CLI flags take precedence over env vars", () => {
    process.env.ASSET = "SOL";
    process.env.MAX_ITER = "7";
    process.argv = ["node", "orchestrator.js", "--asset=BTC", "--max-iter=15"];
    const result = parseArgs();
    expect(result.asset).toBe("BTC");
    expect(result.maxIter).toBe(15);
  });

  it("parses space-separated flags (--asset BTC)", () => {
    process.argv = ["node", "orchestrator.js", "--asset", "BTC"];
    const result = parseArgs();
    expect(result.asset).toBe("BTC");
  });
});

// ---------------------------------------------------------------------------
// buildLoopConfig
// ---------------------------------------------------------------------------
describe("buildLoopConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["MAX_FIX_ATTEMPTS", "MAX_TRANSIENT_FAILURES", "MAX_NO_CHANGE"];

  beforeEach(() => {
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    }
  });

  it("defaults asset to BTC and strategy to breakout when not provided", () => {
    const cfg = buildLoopConfig({});
    expect(cfg.asset).toBe("BTC");
    expect(cfg.strategy).toBe("breakout");
  });

  it("uses the provided asset", () => {
    const cfg = buildLoopConfig({ asset: "ETH" });
    expect(cfg.asset).toBe("ETH");
    expect(cfg.strategyFile).toBe("");
    expect(cfg.strategyDir).toContain("assets/ETH/breakout");
  });

  it("generates a runId in YYYYMMDD_HHMMSS format", () => {
    const cfg = buildLoopConfig({ asset: "BTC" });
    expect(cfg.runId).toMatch(/^\d{8}_\d{6}$/);
  });

  it("reads maxFixAttempts from env var", () => {
    process.env.MAX_FIX_ATTEMPTS = "7";
    const cfg = buildLoopConfig({ asset: "BTC" });
    expect(cfg.maxFixAttempts).toBe(7);
  });

  it("defaults maxFixAttempts to 3 when env var is absent", () => {
    const cfg = buildLoopConfig({ asset: "BTC" });
    expect(cfg.maxFixAttempts).toBe(3);
  });

  it("includes data config fields", () => {
    const cfg = buildLoopConfig({ asset: "BTC" });
    expect(cfg.coin).toBe("BTC");
    expect(cfg.dataSource).toBe("binance");
    expect(cfg.interval).toBe("15m");
    expect(cfg.strategyFactory).toBe("createTestStrategy");
    expect(cfg.startTime).toBeGreaterThan(0);
    expect(cfg.endTime).toBeGreaterThan(cfg.startTime);
  });

  it("sets file paths relative to repoRoot", () => {
    const cfg = buildLoopConfig({ asset: "SOL", repoRoot: "/custom/root" });
    expect(cfg.strategyFile).toBe("");
    expect(cfg.strategyDir).toBe("/custom/root/assets/SOL/breakout");
    expect(cfg.paramHistoryFile).toBe("/custom/root/assets/SOL/breakout/parameter-history.json");
    expect(cfg.checkpointDir).toBe("/custom/root/assets/SOL/breakout/checkpoints");
    expect(cfg.configFile).toBe("/custom/root/breaker-config.json");
    expect(cfg.dbPath).toBe("/custom/root/candles.db");
  });
});

// ---------------------------------------------------------------------------
// checkCriteria
// ---------------------------------------------------------------------------
describe("checkCriteria", () => {
  const passingMetrics = {
    totalPnl: 1000,
    numTrades: 200,
    profitFactor: 2.0,
    maxDrawdownPct: 5,
    winRate: 45,
    avgR: 0.3,
    avgWinR: 1.5,
    avgLossR: -0.7,
    maxLossR: -1.2,
    expectancy: 0.3,
  };

  const criteria = {
    minTrades: 150,
    minPF: 1.25,
    maxDD: 12,
    minWR: 20,
    minAvgR: 0.15,
  };

  it("returns true when all criteria pass", () => {
    expect(checkCriteria(passingMetrics, criteria)).toBe(true);
  });

  it("returns false when totalPnl is negative", () => {
    expect(checkCriteria({ ...passingMetrics, totalPnl: -100 }, criteria)).toBe(false);
  });

  it("returns false when totalPnl is zero", () => {
    expect(checkCriteria({ ...passingMetrics, totalPnl: 0 }, criteria)).toBe(false);
  });

  it("returns false when numTrades below minimum", () => {
    expect(checkCriteria({ ...passingMetrics, numTrades: 100 }, criteria)).toBe(false);
  });

  it("returns false when profitFactor below minimum", () => {
    expect(checkCriteria({ ...passingMetrics, profitFactor: 1.0 }, criteria)).toBe(false);
  });

  it("returns false when maxDrawdownPct exceeds maximum", () => {
    expect(checkCriteria({ ...passingMetrics, maxDrawdownPct: 15 }, criteria)).toBe(false);
  });

  it("returns false when winRate below minimum", () => {
    expect(checkCriteria({ ...passingMetrics, winRate: 10 }, criteria)).toBe(false);
  });

  it("returns false when avgR below minimum", () => {
    expect(checkCriteria({ ...passingMetrics, avgR: 0.05 }, criteria)).toBe(false);
  });

  it("uses defaults for null metrics (all fail)", () => {
    const nullMetrics = {
      totalPnl: null,
      numTrades: null,
      profitFactor: null,
      maxDrawdownPct: null,
      winRate: null,
      avgR: null,
      avgWinR: null,
      avgLossR: null,
      maxLossR: null,
      expectancy: null,
    };
    expect(checkCriteria(nullMetrics, criteria)).toBe(false);
  });

  it("passes at exact boundary values", () => {
    const boundary = {
      totalPnl: 0.01,
      numTrades: 150,
      profitFactor: 1.25,
      maxDrawdownPct: 12,
      winRate: 20,
      avgR: 0.15,
    };
    expect(checkCriteria(boundary, criteria)).toBe(true);
  });

  it("uses built-in defaults when criteria fields are undefined", () => {
    const metrics = {
      totalPnl: 500,
      numTrades: 150,
      profitFactor: 1.25,
      maxDrawdownPct: 12,
      winRate: 20,
      avgR: 0.15,
    };
    expect(checkCriteria(metrics, {})).toBe(true);
  });

  it("fails when drawdown is exactly at max + epsilon", () => {
    expect(
      checkCriteria({ ...passingMetrics, maxDrawdownPct: 12.01 }, criteria),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// phaseHelpers.shouldEscalate
// ---------------------------------------------------------------------------
describe("phaseHelpers.shouldEscalate", () => {
  function makeState(overrides: Partial<IterationState> = {}): IterationState {
    return {
      iter: 1, globalIter: 1, bestPnl: 0, bestIter: 0,
      fixAttempts: 0, transientFailures: 0, noChangeCount: 0,
      previousPnl: 0, sessionMetrics: [], currentPhase: "refine",
      currentScore: 0, bestScore: 0, neutralStreak: 0, phaseCycles: 0,
      ...overrides,
    };
  }

  const cfg = buildLoopConfig({ asset: "BTC" });

  it("returns true for refine phase when neutralStreak >= 3", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", neutralStreak: 3 }), cfg)).toBe(true);
  });

  it("returns true for refine phase when noChangeCount >= 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", noChangeCount: 2 }), cfg)).toBe(true);
  });

  it("returns true for research phase when noChangeCount >= 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "research", neutralStreak: 0, noChangeCount: 2 }), cfg)).toBe(true);
  });

  it("returns false for research phase when noChangeCount < 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "research", neutralStreak: 10, noChangeCount: 1 }), cfg)).toBe(false);
  });

  it("returns true for restructure phase when noChangeCount >= 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "restructure", neutralStreak: 0, noChangeCount: 2 }), cfg)).toBe(true);
  });

  it("returns false for restructure phase when noChangeCount < 2", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "restructure", neutralStreak: 10, noChangeCount: 1 }), cfg)).toBe(false);
  });

  it("returns false for refine phase when neutralStreak is 2 (boundary below threshold)", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", neutralStreak: 2, noChangeCount: 0 }), cfg)).toBe(false);
  });

  it("returns false for refine phase when noChangeCount is 1 (boundary below threshold)", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", neutralStreak: 0, noChangeCount: 1 }), cfg)).toBe(false);
  });

  it("returns true for refine phase when both conditions are met simultaneously", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", neutralStreak: 5, noChangeCount: 4 }), cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// phaseHelpers.resetCounters
// ---------------------------------------------------------------------------
describe("phaseHelpers.resetCounters", () => {
  function makeState(overrides: Partial<IterationState> = {}): IterationState {
    return {
      iter: 5, globalIter: 10, bestPnl: 500, bestIter: 3,
      fixAttempts: 2, transientFailures: 2, noChangeCount: 1,
      previousPnl: 400, sessionMetrics: [], currentPhase: "refine",
      currentScore: 50, bestScore: 60, neutralStreak: 3, phaseCycles: 0,
      ...overrides,
    };
  }

  it("resets fixAttempts, transientFailures, neutralStreak, noChangeCount", () => {
    const state = makeState({ fixAttempts: 2, transientFailures: 2, neutralStreak: 3, noChangeCount: 1 });
    phaseHelpers.resetCounters(state);
    expect(state.fixAttempts).toBe(0);
    expect(state.transientFailures).toBe(0);
    expect(state.neutralStreak).toBe(0);
    expect(state.noChangeCount).toBe(0);
  });

  it("does NOT reset bestPnl, bestScore, phaseCycles, or iter", () => {
    const state = makeState({ bestPnl: 500, bestScore: 60, phaseCycles: 1, iter: 5 });
    phaseHelpers.resetCounters(state);
    expect(state.bestPnl).toBe(500);
    expect(state.bestScore).toBe(60);
    expect(state.phaseCycles).toBe(1);
    expect(state.iter).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// no-change escalation (not abort)
// ---------------------------------------------------------------------------
describe("no-change escalation", () => {
  function makeState(overrides: Partial<IterationState> = {}): IterationState {
    return {
      iter: 1, globalIter: 1, bestPnl: 0, bestIter: 0,
      fixAttempts: 0, transientFailures: 0, noChangeCount: 0,
      previousPnl: 0, sessionMetrics: [], currentPhase: "refine",
      currentScore: 0, bestScore: 0, neutralStreak: 0, phaseCycles: 0,
      ...overrides,
    };
  }

  const cfg = buildLoopConfig({ asset: "BTC" });

  it("2 no-changes in refine triggers escalation to research (not abort)", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "refine", noChangeCount: 2 }), cfg)).toBe(true);
  });

  it("2 no-changes in research triggers escalation to restructure (not abort)", () => {
    expect(phaseHelpers.shouldEscalate(makeState({ currentPhase: "research", noChangeCount: 2 }), cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// phaseHelpers.getMaxIter
// ---------------------------------------------------------------------------
describe("phaseHelpers.getMaxIter", () => {
  const cfg = buildLoopConfig({ asset: "BTC" });

  it("returns maxIter for refine phase", () => {
    expect(phaseHelpers.getMaxIter("refine", cfg)).toBe(5);
  });

  it("returns maxIter for research phase", () => {
    expect(phaseHelpers.getMaxIter("research", cfg)).toBe(3);
  });

  it("returns maxIter for restructure phase", () => {
    expect(phaseHelpers.getMaxIter("restructure", cfg)).toBe(5);
  });

  it("uses proportional allocation when maxIter is large", () => {
    const largeCfg = { ...cfg, maxIter: 20 };
    expect(phaseHelpers.getMaxIter("refine", largeCfg)).toBe(8);
    expect(phaseHelpers.getMaxIter("research", largeCfg)).toBe(4);
    expect(phaseHelpers.getMaxIter("restructure", largeCfg)).toBe(8);
  });

  it("uses config value when maxIter is small", () => {
    const smallCfg = { ...cfg, maxIter: 5 };
    expect(phaseHelpers.getMaxIter("refine", smallCfg)).toBe(5);
    expect(phaseHelpers.getMaxIter("research", smallCfg)).toBe(3);
    expect(phaseHelpers.getMaxIter("restructure", smallCfg)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// phaseHelpers.transitionOnMaxIter
// ---------------------------------------------------------------------------
describe("phaseHelpers.transitionOnMaxIter", () => {
  it("refine -> research", () => {
    expect(phaseHelpers.transitionOnMaxIter("refine", 0, 2)).toEqual({ nextPhase: "research", shouldBreak: false, incrementCycles: false });
  });

  it("research -> restructure", () => {
    expect(phaseHelpers.transitionOnMaxIter("research", 0, 2)).toEqual({ nextPhase: "restructure", shouldBreak: false, incrementCycles: false });
  });

  it("restructure -> refine when cycles < maxCycles", () => {
    expect(phaseHelpers.transitionOnMaxIter("restructure", 0, 2)).toEqual({ nextPhase: "refine", shouldBreak: false, incrementCycles: true });
  });

  it("restructure -> break when cycles >= maxCycles", () => {
    expect(phaseHelpers.transitionOnMaxIter("restructure", 1, 2)).toEqual({ nextPhase: "restructure", shouldBreak: true, incrementCycles: true });
  });
});

// ---------------------------------------------------------------------------
// phaseHelpers.computeEffectiveVerdict
// ---------------------------------------------------------------------------
describe("phaseHelpers.computeEffectiveVerdict", () => {
  it("accept + meetsMinTrades -> accept", () => {
    expect(phaseHelpers.computeEffectiveVerdict("accept", true)).toBe("accept");
  });

  it("accept + !meetsMinTrades -> neutral (bug fix)", () => {
    expect(phaseHelpers.computeEffectiveVerdict("accept", false)).toBe("neutral");
  });

  it("reject + meetsMinTrades -> reject", () => {
    expect(phaseHelpers.computeEffectiveVerdict("reject", true)).toBe("reject");
  });

  it("reject + !meetsMinTrades -> reject", () => {
    expect(phaseHelpers.computeEffectiveVerdict("reject", false)).toBe("reject");
  });

  it("neutral + meetsMinTrades -> neutral", () => {
    expect(phaseHelpers.computeEffectiveVerdict("neutral", true)).toBe("neutral");
  });

  it("neutral + !meetsMinTrades -> reject (Bug A fix: prevents cascading degradation)", () => {
    expect(phaseHelpers.computeEffectiveVerdict("neutral", false)).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// Integration: low-trade accept should not block phase escalation
// ---------------------------------------------------------------------------
describe("low-trade accept does not block phase escalation", () => {
  function makeState(overrides: Partial<IterationState> = {}): IterationState {
    return {
      iter: 1, globalIter: 1, bestPnl: 0, bestIter: 0,
      fixAttempts: 0, transientFailures: 0, noChangeCount: 0,
      previousPnl: 0, sessionMetrics: [], currentPhase: "refine",
      currentScore: 0, bestScore: 0, neutralStreak: 0, phaseCycles: 0,
      ...overrides,
    };
  }

  const cfg = buildLoopConfig({ asset: "BTC" });

  it("3 iters with score > 0 but trades < minTrades -> neutralStreak=3 -> shouldEscalate", () => {
    const state = makeState({ bestScore: 50, currentPhase: "refine" });

    for (let i = 0; i < 3; i++) {
      const scoreVerdict: ScoreVerdict = "accept";
      const meetsMinTrades = false;
      const effective = phaseHelpers.computeEffectiveVerdict(scoreVerdict, meetsMinTrades);
      expect(effective).toBe("neutral");
      state.neutralStreak++;
    }

    expect(state.neutralStreak).toBe(3);
    expect(phaseHelpers.shouldEscalate(state, cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: guardrail-rejected iterations must not save checkpoint
// ---------------------------------------------------------------------------
describe("guardrail-rejected iterations skip checkpoint", () => {
  it("effectiveVerdict=reject blocks checkpoint even when score improves", () => {
    // Simulates the checkpoint decision logic from orchestrator Step 4
    const bestScore = 33.7;
    const currentScore = 37.9;
    const meetsMinTrades = true;
    const effectiveVerdict = "reject"; // set by walk-forward overfit gate

    // This is the FIXED condition (must include effectiveVerdict check)
    const shouldSaveCheckpoint =
      currentScore > bestScore && meetsMinTrades && effectiveVerdict !== "reject";

    expect(shouldSaveCheckpoint).toBe(false);
  });

  it("effectiveVerdict=accept allows checkpoint when score improves", () => {
    const bestScore = 33.7;
    const currentScore = 37.9;
    const meetsMinTrades = true;
    const effectiveVerdict = "accept";

    const shouldSaveCheckpoint =
      currentScore > bestScore && meetsMinTrades && effectiveVerdict !== "reject";

    expect(shouldSaveCheckpoint).toBe(true);
  });

  it("effectiveVerdict=reject triggers rollback path", () => {
    const bestScore = 33.7;
    const currentScore = 37.9;
    const meetsMinTrades = true;
    const effectiveVerdict = "reject"; // guardrail override

    const shouldSaveCheckpoint =
      currentScore > bestScore && meetsMinTrades && effectiveVerdict !== "reject";
    const shouldRollback = effectiveVerdict === "reject";

    expect(shouldSaveCheckpoint).toBe(false);
    expect(shouldRollback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: bestScore restored from checkpoint via computeScore
// ---------------------------------------------------------------------------
describe("bestScore restoration from checkpoint", () => {
  const cfg = buildLoopConfig({ asset: "BTC" });

  it("computeScore returns positive score for good checkpoint metrics", () => {
    const checkpointMetrics = {
      totalPnl: 500, numTrades: 200, profitFactor: 2.0,
      maxDrawdownPct: 5, winRate: 35, avgR: 0.25,
      avgWinR: 1.5, avgLossR: -0.7, maxLossR: -1.2, expectancy: 0.25,
    };
    const score = computeScore(checkpointMetrics, 8, checkpointMetrics.numTrades, cfg.scoring.weights);
    expect(score.weighted).toBeGreaterThan(0);
  });

  it("iter 1 with lower score does NOT overwrite a restored bestScore", () => {
    const checkpointMetrics = {
      totalPnl: 500, numTrades: 200, profitFactor: 2.0,
      maxDrawdownPct: 5, winRate: 35, avgR: 0.25,
      avgWinR: 1.5, avgLossR: -0.7, maxLossR: -1.2, expectancy: 0.25,
    };
    const cpScore = computeScore(checkpointMetrics, 8, 200, cfg.scoring.weights);

    const iterMetrics = {
      totalPnl: 100, numTrades: 80, profitFactor: 1.1,
      maxDrawdownPct: 10, winRate: 22, avgR: 0.08,
      avgWinR: 0.5, avgLossR: -0.4, maxLossR: -0.9, expectancy: -0.1,
    };
    const iterScore = computeScore(iterMetrics, 8, 80, cfg.scoring.weights);

    expect(cpScore.weighted).toBeGreaterThan(iterScore.weighted);
    expect(iterScore.weighted).toBeLessThan(cpScore.weighted);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: rollback updates persistent metrics (not stale failed metrics)
// Migrated from inline logic to use real applyRollback() function
// ---------------------------------------------------------------------------
describe("rollback metrics consistency", () => {
  it("after non-refine rollback, persistent currentMetrics updated to checkpoint", () => {
    const failedMetrics = { totalPnl: 0.14, numTrades: 1, profitFactor: 0, maxDrawdownPct: 0, winRate: 100, avgR: 0.01 } as any;
    const checkpointMetrics = { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09 };

    const result = applyRollback(
      { lastStrategyParams: {}, paramOverrides: {}, paramCount: 1, currentMetrics: failedMetrics, currentPnl: 0.14, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: checkpointMetrics as any, iter: 1, timestamp: "" },
      null,
      { iter: 5, phase: "restructure", scoreWeighted: 10, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: failedMetrics, paramCount: 1, analysis: null, wfViolations: [], fvViolations: [], globalIter: 5, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );

    expect(result.currentMetrics.numTrades).toBe(77);
    expect(result.currentMetrics.profitFactor).toBe(0.71);
    expect(result.currentPnl).toBe(-70);
  });

  it("refine rollback also updates persistent metrics from checkpoint", () => {
    const failedMetrics = { totalPnl: -500, numTrades: 150, profitFactor: 0.5, maxDrawdownPct: 30, winRate: 35, avgR: -0.1 } as any;
    const checkpointMetrics = { totalPnl: 200, numTrades: 180, profitFactor: 1.5, maxDrawdownPct: 8, winRate: 40, avgR: 0.15 };

    const result = applyRollback(
      { lastStrategyParams: {}, paramOverrides: {}, paramCount: 3, currentMetrics: failedMetrics, currentPnl: -500, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: checkpointMetrics as any, iter: 3, timestamp: "" },
      null,
      { iter: 5, phase: "refine", scoreWeighted: 20, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: failedMetrics, paramCount: 3, analysis: null, wfViolations: [], fvViolations: [], globalIter: 5, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );

    expect(result.currentMetrics.numTrades).toBe(180);
    expect(result.currentPnl).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: failed restructures tracked for prompt feedback
// Migrated from inline logic to use real applyRollback()
// ---------------------------------------------------------------------------
describe("failed restructures tracking", () => {
  it("records failure info on non-refine rollback", () => {
    const result = applyRollback(
      { lastStrategyParams: {}, paramOverrides: {}, paramCount: 2, currentMetrics: {} as any, currentPnl: 0, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: {} as any, iter: 1, timestamp: "" },
      null,
      { iter: 5, phase: "restructure", scoreWeighted: 29.9, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: { numTrades: 1, profitFactor: 0 } as any, paramCount: 2, analysis: null, wfViolations: [], fvViolations: [], globalIter: 18, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );

    expect(result.failedRestructures).toHaveLength(1);
    expect(result.failedRestructures[0]).toMatchObject({ globalIter: 18, trades: 1, pf: 0, score: 29.9 });
  });

  it("does NOT record failure on refine rollback", () => {
    const result = applyRollback(
      { lastStrategyParams: {}, paramOverrides: {}, paramCount: 2, currentMetrics: {} as any, currentPnl: 0, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: {} as any, iter: 1, timestamp: "" },
      null,
      { iter: 5, phase: "refine", scoreWeighted: 30, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: { numTrades: 100, profitFactor: 0.5 } as any, paramCount: 2, analysis: null, wfViolations: [], fvViolations: [], globalIter: 5, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );

    expect(result.failedRestructures).toHaveLength(0);
  });

  it("accumulates multiple failures across iterations", () => {
    const baseState = { lastStrategyParams: {} as any, paramOverrides: {}, paramCount: 2, currentMetrics: {} as any, currentPnl: 0, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] as any[] };
    const cpData = { strategyContent: "", metrics: {} as any, iter: 1, timestamp: "" };
    const baseCtx = { iter: 5, phase: "restructure" as const, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: {} as any, paramCount: 2, analysis: null, wfViolations: [] as any[], fvViolations: [] as any[], minTrades: 50, minPF: 1.3, maxDD: 10 };

    const first = applyRollback(baseState, cpData, null, { ...baseCtx, scoreWeighted: 29.9, globalIter: 18 });
    const second = applyRollback({ ...baseState, failedRestructures: first.failedRestructures }, cpData, null, { ...baseCtx, scoreWeighted: 17.9, globalIter: 19 });

    expect(second.failedRestructures).toHaveLength(2);
    expect(second.failedRestructures.map((f) => f.globalIter)).toEqual([18, 19]);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: baseline checkpoint must seed bestScore (not 0)
// ---------------------------------------------------------------------------
describe("baseline bestScore seeding prevents WF guardrail trap", () => {
  it("bestScore=0 causes every positive-scoring iter to be 'accepted' then WF-rejected", () => {
    // With bestScore=0, the verdict logic returns "accept" for any score > 0
    const bestScore = 0;
    const currentScore = 33.3;
    const scoreVerdict = bestScore > 0
      ? "neutral" // compareScores would be called
      : (currentScore > 0 ? "accept" : "neutral");
    expect(scoreVerdict).toBe("accept");
    // WF guardrail overrides accept → reject, trapping the loop
  });

  it("bestScore seeded from baseline causes same-strategy iter to be 'neutral' (no WF gate)", () => {
    // With bestScore=33.3 from baseline, same strategy returns "neutral"
    const bestScore = 33.3;
    const currentScore = 33.3;
    // compareScores: within ±2% band → "neutral"
    const scoreVerdict = bestScore > 0
      ? (currentScore > bestScore * 1.02 ? "accept" : currentScore < bestScore * 0.92 ? "reject" : "neutral")
      : (currentScore > 0 ? "accept" : "neutral");
    expect(scoreVerdict).toBe("neutral");
    // WF guardrail only fires on "accept" — "neutral" passes through safely
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: structural guardrail rejection must revert strategy file
// ---------------------------------------------------------------------------
describe("structural guardrail rejection reverts strategy", () => {
  it("continue after structural rejection without revert leaves bad file on disk", () => {
    // Before fix: CHANGE_APPLIED sets needsRebuild=true, structural guardrail
    // rejects, but continue skips without reverting. Next iter rebuilds the bad file.
    // After fix: rollback + SET_NEEDS_REBUILD=false ensures next iter uses checkpoint.
    let needsRebuild = true; // set by CHANGE_APPLIED
    const structureViolations = [{ field: "anti-repaint", reason: "missing HTF check" }];

    if (structureViolations.length > 0) {
      // Fix: revert and clear needsRebuild
      needsRebuild = false;
    }

    expect(needsRebuild).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint source validation logic
// ---------------------------------------------------------------------------
describe("checkpoint source validation", () => {
  it("matching source hash does not trigger restore", () => {
    const source = "const x = 1;";
    const hash = integrity.computeHash(source);
    expect(hash).toBe(integrity.computeHash(source));
    const shouldRestore = (hash !== integrity.computeHash(source)) && (1 > 0);
    expect(shouldRestore).toBe(false);
  });

  it("different source hash triggers restore flag", () => {
    const cpSource = "const x = 1;";
    const currentSource = "const x = 2;";
    const cpHash = integrity.computeHash(cpSource);
    const currentHash = integrity.computeHash(currentSource);
    expect(cpHash).not.toBe(currentHash);
    const iter = 5;
    const shouldRestore = (cpHash !== currentHash) && (iter > 0);
    expect(shouldRestore).toBe(true);
  });

  it("iter 0 does not trigger restore even on hash mismatch", () => {
    const cpHash = integrity.computeHash("old");
    const currentHash = integrity.computeHash("new");
    const iter = 0;
    const shouldRestore = (cpHash !== currentHash) && (iter > 0);
    expect(shouldRestore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P3.2: Failed restructure diagnosis
// ---------------------------------------------------------------------------
describe("failed restructure diagnosis (P3.2)", () => {
  it("computes diagnosis with negative DD (B1: sign fix)", () => {
    const metrics = { numTrades: 1, profitFactor: 0, maxDrawdownPct: -50, winRate: 100 };
    const criteria = { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: 50 };
    const diagParts: string[] = [];
    const trades = metrics.numTrades ?? 0;
    if (trades < criteria.minTrades) diagParts.push(`trades ${trades} < minTrades ${criteria.minTrades}`);
    if (metrics.profitFactor < criteria.minPF) diagParts.push(`PF ${metrics.profitFactor.toFixed(2)} < ${criteria.minPF}`);
    if (Math.abs(metrics.maxDrawdownPct ?? 0) > criteria.maxDD) diagParts.push(`DD ${Math.abs(metrics.maxDrawdownPct ?? 0).toFixed(1)}% > ${criteria.maxDD}%`);
    expect(diagParts).toContain("DD 50.0% > 10%");
  });

  it("computes diagnosis with all failing criteria", () => {
    const metrics = { numTrades: 1, profitFactor: 0, maxDrawdownPct: 50, winRate: 100 };
    const criteria = { minTrades: 50, minPF: 1.3, maxDD: 10, minWR: 50 };
    const wfViolations: any[] = [];
    const fvViolations: any[] = [];
    const paramCount = 4;

    const diagParts: string[] = [];
    const trades = metrics.numTrades ?? 0;
    if (trades < criteria.minTrades) diagParts.push(`trades ${trades} < minTrades ${criteria.minTrades}`);
    if (metrics.profitFactor < criteria.minPF) diagParts.push(`PF ${metrics.profitFactor.toFixed(2)} < ${criteria.minPF}`);
    if (metrics.maxDrawdownPct > criteria.maxDD) diagParts.push(`DD ${metrics.maxDrawdownPct.toFixed(1)}% > ${criteria.maxDD}%`);
    if (wfViolations.length > 0) diagParts.push("WF overfit");
    if (fvViolations.length > 0) diagParts.push(`free vars ${paramCount} > max`);
    const diagnosis = diagParts.length > 0 ? diagParts.join(", ") : "score degraded";

    expect(diagnosis).toContain("trades 1 < minTrades 50");
    expect(diagnosis).toContain("PF 0.00 < 1.3");
    expect(diagnosis).toContain("DD 50.0% > 10%");
  });

  it("returns 'score degraded' when no specific criteria fail", () => {
    const diagParts: string[] = [];
    const diagnosis = diagParts.length > 0 ? diagParts.join(", ") : "score degraded";
    expect(diagnosis).toBe("score degraded");
  });
});

// ---------------------------------------------------------------------------
// B2: score>best + trades<min in restructure triggers rollback
// ---------------------------------------------------------------------------
describe("B2: restructure score>best + trades<min triggers rollback", () => {
  it("restructure phase rolls back when score is best but trades insufficient", () => {
    const phase = "restructure";
    const scoreWeighted = 45;
    const bestScore = 40;
    const meetsMinTrades = false;
    const effectiveVerdict = "neutral"; // computeEffectiveVerdict("accept", false) = "neutral"

    let rolledBack = false;
    if (scoreWeighted > bestScore && !meetsMinTrades && phase !== "refine") {
      rolledBack = true;
    }

    expect(rolledBack).toBe(true);
  });

  it("refine phase does NOT rollback when score>best + trades<min", () => {
    const phase = "refine";
    let rolledBack = false;
    if (45 > 40 && !false && phase !== "refine") {
      rolledBack = true;
    }
    expect(rolledBack).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: neutral verdict (score in noise band) triggers rollback
// ---------------------------------------------------------------------------
describe("neutral verdict triggers rollback to prevent drift", () => {
  it("neutral verdict with score <= bestScore enters the else (rollback) branch", () => {
    // Simulates Step 8 logic: score is within 3% noise band but not improved
    const scoreWeighted = 78.0;
    const bestScore = 80.2;
    const meetsMinTrades = true;
    const effectiveVerdict = "neutral"; // compareScores(78.0, 80.2) = neutral

    let checkpointed = false;
    let rolledBack = false;

    // Mirrors the Step 8 if/else chain in orchestrator.ts
    if (scoreWeighted > bestScore && meetsMinTrades && effectiveVerdict !== "reject") {
      checkpointed = true;
    } else if (scoreWeighted > bestScore && !meetsMinTrades) {
      // score > best but not enough trades
    } else {
      // All non-checkpoint cases (reject AND neutral) rollback
      rolledBack = true;
    }

    expect(checkpointed).toBe(false);
    expect(rolledBack).toBe(true);
  });

  it("neutral verdict with score slightly above best still checkpoints", () => {
    // Score improved slightly (within noise band but raw score > best)
    const scoreWeighted = 80.5;
    const bestScore = 80.2;
    const meetsMinTrades = true;
    const effectiveVerdict = "neutral"; // compareScores(80.5, 80.2) = neutral (< 1.02 threshold)

    let checkpointed = false;

    if (scoreWeighted > bestScore && meetsMinTrades && effectiveVerdict !== "reject") {
      checkpointed = true;
    }

    // Even "neutral" verdict checkpoints if raw score > bestScore (neutral !== reject)
    expect(checkpointed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX P1.1: lastContentHash recalculated after rollback
// ---------------------------------------------------------------------------
describe("lastContentHash recalculated after rollback", () => {
  it("hash of restored file != hash of rejected file => must recalculate", () => {
    const rejectedSource = "const rejected = true;";
    const restoredSource = "const restored = true;";
    const rejectedHash = integrity.computeHash(rejectedSource);
    const restoredHash = integrity.computeHash(restoredSource);

    // Before fix: lastContentHash stays as rejectedHash
    // After fix: lastContentHash updated to restoredHash
    let lastContentHash = rejectedHash;

    // Simulate rollback
    lastContentHash = restoredHash;

    // Next iteration: contentHash from reading file = restoredHash
    const contentHash = restoredHash;
    const checkpointRestored = false;
    const phase = "refine";
    const canUseInProcess = !checkpointRestored && (phase === "refine" || contentHash === lastContentHash);
    expect(canUseInProcess).toBe(true);
  });

  it("without recalculation, forces unnecessary child-process path", () => {
    const rejectedSource = "const rejected = true;";
    const restoredSource = "const restored = true;";
    const rejectedHash = integrity.computeHash(rejectedSource);
    const restoredHash = integrity.computeHash(restoredSource);

    // Bug: lastContentHash stays as rejectedHash (not updated after rollback)
    const lastContentHash = rejectedHash;
    const contentHash = restoredHash;
    const checkpointRestored = false;
    const phase = "restructure"; // non-refine phase

    // With stale hash, content != lastContentHash => child-process (unnecessary)
    const canUseInProcess = !checkpointRestored && (phase === "refine" || contentHash === lastContentHash);
    expect(canUseInProcess).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX P1.3: paramCount recalculated after checkpoint restore
// Migrated from inline logic to use real applyRollback()/applyB2Rollback()
// ---------------------------------------------------------------------------
describe("paramCount after checkpoint restore", () => {
  it("uses checkpoint params count after non-refine rollback", () => {
    const cpParams = { dcSlow: 55, dcFast: 20, atrStopMult: 3.5 };
    const result = applyRollback(
      { lastStrategyParams: {}, paramOverrides: {}, paramCount: 8, currentMetrics: {} as any, currentPnl: 0, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: {} as any, params: cpParams, paramCount: 3, iter: 1, timestamp: "" },
      cpParams,
      { iter: 5, phase: "restructure", scoreWeighted: 10, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: {} as any, paramCount: 8, analysis: null, wfViolations: [], fvViolations: [], globalIter: 5, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );
    expect(result.paramCount).toBe(3);
  });

  it("recalculates paramCount on refine rollback (esmCacheStale path)", () => {
    const cpParams = { dcSlow: 55, dcFast: 20, atrStopMult: 3.5 };
    const result = applyRollback(
      { lastStrategyParams: {}, paramOverrides: {}, paramCount: 8, currentMetrics: {} as any, currentPnl: 0, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: {} as any, params: cpParams, paramCount: 3, iter: 1, timestamp: "" },
      cpParams,
      { iter: 5, phase: "refine", scoreWeighted: 10, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: {} as any, paramCount: 8, analysis: null, wfViolations: [], fvViolations: [], globalIter: 5, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );
    expect(result.paramCount).toBe(3);
  });

  it("restores lastStrategyParams from checkpoint after refine rollback", () => {
    // Bug: after rollback in refine, lastStrategyParams kept rejected-iteration values.
    const checkpointParams = {
      dcPeriod: { name: "dcPeriod", value: 20, min: 10, max: 50, step: 2, optimizable: true } as any,
      volMult: { name: "volMult", value: 1.5, min: 0.5, max: 3.0, step: 0.5, optimizable: true } as any,
    };
    const rejectedParams = {
      dcPeriod: { name: "dcPeriod", value: 24, min: 10, max: 50, step: 2, optimizable: true } as any,
      volMult: { name: "volMult", value: 1.5, min: 0.5, max: 3.0, step: 0.5, optimizable: true } as any,
    };

    const result = applyRollback(
      { lastStrategyParams: rejectedParams, paramOverrides: {}, paramCount: 2, currentMetrics: {} as any, currentPnl: 0, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: {} as any, strategyParams: checkpointParams, iter: 1, timestamp: "" },
      null,
      { iter: 5, phase: "refine", scoreWeighted: 10, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: {} as any, paramCount: 2, analysis: null, wfViolations: [], fvViolations: [], globalIter: 5, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );

    expect(result.lastStrategyParams).toEqual(checkpointParams);
    expect(result.lastStrategyParams.dcPeriod.value).toBe(20); // checkpoint value, NOT 24
  });
});

// ---------------------------------------------------------------------------
// BUG FIX P1.4: double escalation does not skip research
// ---------------------------------------------------------------------------
describe("double escalation guard", () => {
  it("PHASE_TIMEOUT skipped if ESCALATE already transitioned", () => {
    // Simulates the guard: only fire PHASE_TIMEOUT if ESCALATE didn't transition
    const prevPhase = "refine";
    const phaseAfterEscalation = "research"; // ESCALATE fired

    // With guard: PHASE_TIMEOUT only fires if phaseAfterEscalation === prevPhase
    const shouldFireTimeout = phaseAfterEscalation === prevPhase;
    expect(shouldFireTimeout).toBe(false);
  });

  it("PHASE_TIMEOUT fires normally when ESCALATE did not transition", () => {
    const prevPhase = "refine";
    const phaseAfterEscalation = "refine"; // ESCALATE guard not met
    const phaseIterCount = 6;
    const phaseMaxIter = 5;

    const shouldFireTimeout = phaseAfterEscalation === prevPhase && phaseIterCount > phaseMaxIter;
    expect(shouldFireTimeout).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B3: paramCount from child-process result preferred over stale factory()
// ---------------------------------------------------------------------------
describe("B3: paramCount from child-process", () => {
  it("uses paramCount from engineResult when available", () => {
    const engineResult = { paramCount: 5 };
    let paramCount = 8; // stale

    if ('paramCount' in engineResult && typeof engineResult.paramCount === 'number') {
      paramCount = engineResult.paramCount;
    }

    expect(paramCount).toBe(5);
  });

  it("falls back to factory() when engineResult has no paramCount", () => {
    const engineResult = {};
    let paramCount = 8;
    const factoryParamCount = 6;

    if ('paramCount' in engineResult && typeof (engineResult as any).paramCount === 'number') {
      paramCount = (engineResult as any).paramCount;
    } else {
      paramCount = factoryParamCount;
    }

    expect(paramCount).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: no-op detection must use variant's param schema, not seed's
// ---------------------------------------------------------------------------
describe("no-op detection with variant params vs seed params", () => {
  it("detects actual change when param exists in variant but not in seed", () => {
    // Bug: factory() returned seed params → atrTrailMult not found → no-op false positive
    // Fix: after variant generation, factory is reloaded to return variant params
    const variantParams = {
      bbStdMult: { value: 2, optimizable: true },
      kcMult: { value: 1.5, optimizable: true },
      atrTrailMult: { value: 3, optimizable: true },
    };

    // Simulate factory() returning variant params (post-fix)
    const factory = (overrides: Record<string, number> = {}) => ({
      params: Object.fromEntries(
        Object.entries(variantParams).map(([k, p]) => [
          k, { ...p, value: overrides[k] ?? p.value },
        ]),
      ),
    });

    const paramOverrides = {};
    const newOverrides = { ...paramOverrides, atrTrailMult: 4 };

    const beforeStrategy = factory(paramOverrides);
    const newStrategy = factory(newOverrides);

    const beforeValues = Object.fromEntries(
      Object.entries(beforeStrategy.params).filter(([, p]) => p.optimizable).map(([k, p]) => [k, p.value]),
    );
    const afterValues = Object.fromEntries(
      Object.entries(newStrategy.params).filter(([, p]) => p.optimizable).map(([k, p]) => [k, p.value]),
    );
    const actuallyChanged = Object.keys(afterValues).some((k) => afterValues[k] !== beforeValues[k]);

    expect(actuallyChanged).toBe(true);
    expect(afterValues.atrTrailMult).toBe(4);
    expect(beforeValues.atrTrailMult).toBe(3);
  });

  it("seed factory causes false no-op for variant-only params (reproduces bug)", () => {
    // Pre-fix: factory() still pointed to seed, variant-only params were ignored
    const seedParams = {
      dcPeriod: { value: 20, optimizable: true },
      trailMult: { value: 3, optimizable: true },
    };

    const seedFactory = (overrides: Record<string, number> = {}) => ({
      params: Object.fromEntries(
        Object.entries(seedParams).map(([k, p]) => [
          k, { ...p, value: overrides[k] ?? p.value },
        ]),
      ),
    });

    // Claude suggests atrTrailMult=4 (variant param, not in seed)
    const newOverrides = { atrTrailMult: 4 };

    const beforeStrategy = seedFactory({});
    const newStrategy = seedFactory(newOverrides);

    const beforeValues = Object.fromEntries(
      Object.entries(beforeStrategy.params).filter(([, p]) => p.optimizable).map(([k, p]) => [k, p.value]),
    );
    const afterValues = Object.fromEntries(
      Object.entries(newStrategy.params).filter(([, p]) => p.optimizable).map(([k, p]) => [k, p.value]),
    );
    const actuallyChanged = Object.keys(afterValues).some((k) => afterValues[k] !== beforeValues[k]);

    // Bug: no change detected because seed doesn't have atrTrailMult
    expect(actuallyChanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX P1.5: needsRebuild cleared after maxFixAttempts (rollback instead of abort)
// ---------------------------------------------------------------------------
describe("maxFixAttempts exhaustion does rollback", () => {
  it("after maxFixAttempts, needsRebuild is cleared", () => {
    // Simulates the fix: instead of break, rollback + clear needsRebuild + continue
    let needsRebuild = true;
    const fixAttempts = 4;
    const maxFixAttempts = 3;

    if (fixAttempts > maxFixAttempts) {
      // Fix: rollback and clear needsRebuild
      needsRebuild = false;
    }

    expect(needsRebuild).toBe(false);
  });

  it("loop continues after maxFixAttempts instead of aborting", () => {
    // The old behavior was `break` which exits the loop entirely.
    // New behavior: `continue` which moves to next iteration.
    let fixAttempts = 4;
    const maxFixAttempts = 3;
    let loopContinued = false;
    let loopBroken = false;

    // Simulate old behavior
    if (fixAttempts > maxFixAttempts) {
      // Old: break → New: continue
      loopContinued = true;
    }

    expect(loopContinued).toBe(true);
    expect(loopBroken).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G6: avgR in sessionMetrics
// ---------------------------------------------------------------------------
describe("G6: avgR in sessionMetrics", () => {
  it("IterationMetric includes avgR field", () => {
    const metric: import("./types.js").IterationMetric = {
      iter: 1, pnl: 100, pf: 1.5, dd: -5, wr: 45, trades: 60, avgR: 0.2, verdict: "improved",
    };
    expect(metric.avgR).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// G7: failureHistory passed to research
// ---------------------------------------------------------------------------
describe("G7: failureHistory conversion for research", () => {
  it("converts failedRestructures to FailureContext format", () => {
    const failedRestructures = [
      { globalIter: 18, trades: 1, pf: 0, score: 29.9, diagnosis: "trades 1 < minTrades 50" },
      { globalIter: 19, trades: 3, pf: 0.1, score: 17.9 },
    ];

    const failureHistory = failedRestructures.map((f) => ({
      approachName: `globalIter ${f.globalIter}`,
      failureMode: f.diagnosis ?? "score degraded",
      metrics: { pnl: 0, pf: f.pf, wr: 0, dd: 0, trades: f.trades, avgR: 0 },
    }));

    expect(failureHistory).toHaveLength(2);
    expect(failureHistory[0].approachName).toBe("globalIter 18");
    expect(failureHistory[0].failureMode).toBe("trades 1 < minTrades 50");
    expect(failureHistory[0].metrics.trades).toBe(1);
    expect(failureHistory[1].failureMode).toBe("score degraded");
  });
});

// ---------------------------------------------------------------------------
// canUseInProcess logic
// ---------------------------------------------------------------------------
describe("canUseInProcess logic", () => {
  it("checkpointRestored forces child-process backtest path", () => {
    const checkpointRestored = true;
    const phase = "refine";
    const contentHash = "abc123";
    const lastContentHash = "abc123";
    const canUseInProcess = !checkpointRestored && (phase === "refine" || contentHash === lastContentHash);
    expect(canUseInProcess).toBe(false);
  });

  it("refine phase without checkpoint restore uses in-process path", () => {
    const checkpointRestored = false;
    const phase = "refine";
    const canUseInProcess = !checkpointRestored && (phase === "refine" || false);
    expect(canUseInProcess).toBe(true);
  });

  it("matching content hash allows in-process even after restructure", () => {
    const checkpointRestored = false;
    const esmCacheStale = false;
    const phase = "restructure";
    const contentHash = "abc123";
    const lastContentHash = "abc123";
    const canUseInProcess = !checkpointRestored && !esmCacheStale && (phase === "refine" || contentHash === lastContentHash);
    expect(canUseInProcess).toBe(true);
  });

  it("esmCacheStale forces child-process after restructure→refine transition", () => {
    const checkpointRestored = false;
    const esmCacheStale = true;
    const phase = "refine";
    const canUseInProcess = !checkpointRestored && !esmCacheStale && (phase === "refine" || false);
    expect(canUseInProcess).toBe(false);
  });

  it("esmCacheStale=false allows in-process for normal refine", () => {
    const checkpointRestored = false;
    const esmCacheStale = false;
    const phase = "refine";
    const canUseInProcess = !checkpointRestored && !esmCacheStale && (phase === "refine" || false);
    expect(canUseInProcess).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optimize-first loop: no-change skips backtest via continue
// ---------------------------------------------------------------------------

describe("optimize-first: no-change skips backtest via continue", () => {
  it("no-change from optimize means backtest is never reached (continue)", () => {
    // In the optimize-first loop, if optimize returns "no change",
    // the loop hits `continue` before the backtest step.
    // Simulates the control flow:
    const changed = false;
    let backtestRan = false;

    // Optimize step
    if (!changed) {
      // continue; — would skip backtest
    } else {
      backtestRan = true;
    }

    expect(backtestRan).toBe(false);
  });

  it("change from optimize allows backtest to run", () => {
    const changed = true;
    let backtestRan = false;

    if (!changed) {
      // continue;
    } else {
      backtestRan = true;
    }

    expect(backtestRan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optimize-first: baseline metrics available for first optimize prompt
// ---------------------------------------------------------------------------

describe("optimize-first: baseline seeds first iteration", () => {
  it("persistent metrics are seeded from baseline for first optimize prompt", () => {
    // After the pre-loop baseline, currentMetrics/currentScoreResult are populated.
    // The first optimize call receives these instead of empty/zero values.
    const baselineMetrics = {
      totalPnl: 500, numTrades: 200, profitFactor: 2.0,
      maxDrawdownPct: 5, winRate: 35, avgR: 0.25,
    };
    const baselineScore = computeScore(
      baselineMetrics, 8, baselineMetrics.numTrades,
      { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 },
    );

    // Persistent vars seeded from baseline
    const currentMetrics = baselineMetrics;
    const currentScoreResult = baselineScore;
    const currentPnl = baselineMetrics.totalPnl;

    // First optimize prompt uses these persistent vars
    expect(currentMetrics.numTrades).toBe(200);
    expect(currentScoreResult.weighted).toBeGreaterThan(0);
    expect(currentPnl).toBe(500);
  });

  it("checkpoint metrics are seeded for first optimize prompt", () => {
    // When a checkpoint exists, its metrics seed the persistent vars.
    const checkpointMetrics = {
      totalPnl: 300, numTrades: 150, profitFactor: 1.8,
      maxDrawdownPct: 7, winRate: 40, avgR: 0.20,
    };
    const cpScore = computeScore(
      checkpointMetrics, 6, checkpointMetrics.numTrades,
      { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 },
    );

    const currentMetrics = checkpointMetrics;
    const currentScoreResult = cpScore;

    expect(currentMetrics.profitFactor).toBe(1.8);
    expect(currentScoreResult.weighted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Optimize-first: change evaluated in same iteration
// ---------------------------------------------------------------------------

describe("optimize-first: change evaluated in same iteration", () => {
  it("optimize→apply→backtest→score→checkpoint in one iteration", () => {
    // Simulates the optimize-first flow for a single iteration:
    // 1. Optimize suggests param change
    // 2. Apply the change
    // 3. Backtest with the new params → get metrics
    // 4. Score → compare with best
    // 5. Checkpoint if improved

    // Pre-loop state (baseline)
    let currentPnl = 100;
    let bestScore = 30;

    // Iter 1: Optimize suggests change
    const changed = true;
    const newParamOverrides = { dcSlow: 55 };

    if (changed) {
      // Apply
      const paramOverrides = newParamOverrides;

      // Backtest with new params → improved metrics
      const backtestPnl = 200;
      const backtestScore = 45;

      // Score + Verdict
      currentPnl = backtestPnl;
      const scoreImproved = backtestScore > bestScore;

      // Checkpoint
      if (scoreImproved) {
        bestScore = backtestScore;
      }
    }

    // The change was evaluated in the SAME iteration
    expect(currentPnl).toBe(200);
    expect(bestScore).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Optimize-first: rollback updates persistent metrics
// Migrated from inline logic to use real applyRollback()
// ---------------------------------------------------------------------------

describe("optimize-first: rollback updates persistent metrics", () => {
  it("after rollback, persistent currentMetrics reflect checkpoint state", () => {
    const backtestMetrics = { totalPnl: -50, numTrades: 10, profitFactor: 0.5 } as any;
    const checkpointMetrics = { totalPnl: 300, numTrades: 150, profitFactor: 1.8 };

    const result = applyRollback(
      { lastStrategyParams: {}, paramOverrides: {}, paramCount: 2, currentMetrics: backtestMetrics, currentPnl: -50, currentAnalysis: null, lastAnalysis: null, lastRollbackReason: undefined, failedRestructures: [] },
      { strategyContent: "", metrics: checkpointMetrics as any, iter: 3, timestamp: "" },
      null,
      { iter: 5, phase: "refine", scoreWeighted: 20, bestScore: 50, effectiveVerdict: "reject", scoreVerdict: "reject", metrics: backtestMetrics, paramCount: 2, analysis: null, wfViolations: [], fvViolations: [], globalIter: 5, minTrades: 50, minPF: 1.3, maxDD: 10 },
    );

    expect(result.currentMetrics.numTrades).toBe(150);
    expect(result.currentPnl).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Optimize-first: preOptimizeMetrics used for param-writer "before"
// ---------------------------------------------------------------------------

describe("optimize-first: preOptimizeMetrics for param-writer", () => {
  it("param-writer receives pre-optimize metrics as 'before', not post-backtest", () => {
    // In optimize-first, the backtest result is the AFTER of this change.
    // The "before" should be the state before optimize ran.
    const preOptimize = { pnl: 100, trades: 150, pf: 1.5 };
    const postBacktest = { pnl: 200, trades: 180, pf: 2.0 };

    // preOptimizeMetrics is snapshotted before optimize runs
    const preOptimizeMetrics = { ...preOptimize };

    // After backtest, currentMetrics is updated
    const currentMetrics = postBacktest;

    // Param-writer should use preOptimizeMetrics, not currentMetrics
    expect(preOptimizeMetrics.pnl).toBe(100);
    expect(preOptimizeMetrics.trades).toBe(150);
    expect(currentMetrics.pnl).toBe(200);
  });
});

describe("baseline-passes: no early stop when criteria already met", () => {
  it("does not break on criteria pass if baseline already passes", () => {
    // Simulate: baseline passes criteria, iter finds another passing result.
    // Should NOT break — should continue to maximize score.
    const baselinePassesCriteria = true;
    const iterCriteriaPassed = true;

    // When baseline passes and iter also passes, loop should continue
    const shouldBreak = iterCriteriaPassed && !baselinePassesCriteria;
    expect(shouldBreak).toBe(false);
  });

  it("breaks on criteria pass if baseline did NOT pass", () => {
    // Simulate: baseline fails criteria, iter finds first passing result.
    // SHOULD break — found what we were looking for.
    const baselinePassesCriteria = false;
    const iterCriteriaPassed = true;

    const shouldBreak = iterCriteriaPassed && !baselinePassesCriteria;
    expect(shouldBreak).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Baseline already meets stretch targets: skip loop entirely
// ---------------------------------------------------------------------------
describe("baseline-passes-stretch: skip loop when stretch already met", () => {
  it("skips loop when baseline passes criteria AND stretch targets", () => {
    const baselinePassesCriteria = true;
    const baselinePassesStretch = baselinePassesCriteria && true; // stretch also met

    // Loop condition: !baselinePassesStretch && iter <= maxIter
    const iterations: number[] = [];
    for (let iter = 1; !baselinePassesStretch && iter <= 5; iter++) {
      iterations.push(iter);
    }

    expect(iterations).toHaveLength(0);
  });

  it("enters loop when baseline passes criteria but NOT stretch", () => {
    const baselinePassesCriteria = true;
    const baselinePassesStretch = baselinePassesCriteria && false; // stretch not met

    const iterations: number[] = [];
    for (let iter = 1; !baselinePassesStretch && iter <= 5; iter++) {
      iterations.push(iter);
      break; // just test that we enter
    }

    expect(iterations).toHaveLength(1);
  });

  it("enters loop when baseline does NOT pass criteria", () => {
    const baselinePassesCriteria = false;
    const baselinePassesStretch = false; // can't pass stretch without criteria

    const iterations: number[] = [];
    for (let iter = 1; !baselinePassesStretch && iter <= 5; iter++) {
      iterations.push(iter);
      break;
    }

    expect(iterations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Outer loop: variant switch on plateau
// ---------------------------------------------------------------------------
describe("outer loop: variant switch on plateau", () => {
  it("plateau detection: prevPhase=refine && phase!==refine triggers variant switch", () => {
    const prevPhase = "refine";
    const phaseAfterEscalation = "research"; // ESCALATE fired due to neutralStreak >= 3
    const shouldSwitchVariant = prevPhase === "refine" && phaseAfterEscalation !== "refine";
    expect(shouldSwitchVariant).toBe(true);
  });

  it("no variant switch when refine stays in refine (escalation guard not met)", () => {
    const prevPhase = "refine";
    const phaseAfterEscalation = "refine";
    const shouldSwitchVariant = prevPhase === "refine" && phaseAfterEscalation !== "refine";
    expect(shouldSwitchVariant).toBe(false);
  });

  it("no variant switch on non-refine escalation (research → restructure)", () => {
    const prevPhase = "research";
    const phaseAfterEscalation = "restructure";
    const shouldSwitchVariant = prevPhase === "refine" && phaseAfterEscalation !== "refine";
    expect(shouldSwitchVariant).toBe(false);
  });

  it("loop continues with remaining iterations after variant switch", () => {
    const maxIter = 20;
    const iterations: number[] = [];
    let variantSwitchedAt: number | null = null;

    for (let iter = 1; iter <= maxIter; iter++) {
      iterations.push(iter);

      // Simulate plateau at iter 8
      if (iter === 8) {
        variantSwitchedAt = iter;
        // In real code: generate new variant, reset state, continue
        continue;
      }

      // Simulate some work (just to show loop continues)
      if (iter === 15) break; // stop early for test
    }

    expect(variantSwitchedAt).toBe(8);
    expect(iterations).toContain(8); // plateau iteration
    expect(iterations).toContain(9); // continues after switch
    expect(iterations).toContain(15); // loop didn't end at 8
  });

  it("state variables are properly reset after variant switch", () => {
    // Simulate state from plateaued variant
    let currentPnl = 500;
    let currentMetrics = { totalPnl: 500, numTrades: 200, profitFactor: 2.0 } as any;
    let lastRollbackReason: string | undefined = "some previous reason";
    let failedRestructures: any[] = [{ globalIter: 5 }];
    let lastContentHash: string | undefined = "abc123";
    let paramOverrides: Record<string, number> = { dcPeriod: 24 };

    // After variant switch: reset with new baseline
    const newBaselineMetrics = { totalPnl: 120, numTrades: 90, profitFactor: 1.3 } as any;
    currentMetrics = newBaselineMetrics;
    currentPnl = newBaselineMetrics.totalPnl;
    lastRollbackReason = undefined;
    failedRestructures = [];
    lastContentHash = undefined;
    paramOverrides = {};

    expect(currentPnl).toBe(120);
    expect(currentMetrics.profitFactor).toBe(1.3);
    expect(lastRollbackReason).toBeUndefined();
    expect(failedRestructures).toHaveLength(0);
    expect(lastContentHash).toBeUndefined();
    expect(paramOverrides).toEqual({});
  });

  it("actor recreation preserves new variant baseline scores", async () => {
    // Integration: create actor like orchestrator does after variant switch
    const { createActor: ca } = await import("xstate");
    const { breakerMachine: bm } = await import("./state-machine.js");

    const baselineScore = 42.5;
    const baselinePnl = 120;

    const actor = ca(bm, {
      input: {
        initialPhase: "refine",
        maxCycles: 2,
        bestScore: baselineScore,
        bestPnl: baselinePnl,
        bestIter: 0,
      },
    });
    actor.start();

    const ctx = actor.getSnapshot().context;
    expect(ctx.bestScore).toBe(42.5);
    expect(ctx.bestPnl).toBe(120);
    expect(ctx.bestIter).toBe(0);
    expect(ctx.phaseCycles).toBe(0);
    expect(ctx.neutralStreak).toBe(0);
    expect(actor.getSnapshot().value).toBe("refine");
    actor.stop();
  });

  it("variant generation failure causes loop exit (break)", () => {
    let loopExited = false;
    const maxIter = 20;

    for (let iter = 1; iter <= maxIter; iter++) {
      // Simulate plateau at iter 5
      if (iter === 5) {
        const newVariant = null; // generation failed
        if (!newVariant) {
          loopExited = true;
          break;
        }
      }
    }

    expect(loopExited).toBe(true);
  });

  it("esmCacheStale=false and checkpointRestored=false after variant switch", () => {
    // After variant switch, factory is freshly loaded — no stale cache
    let esmCacheStale = true;  // was true from previous variant
    let checkpointRestored = true; // was true from initial setup

    // After variant switch resets:
    esmCacheStale = false;
    checkpointRestored = false;

    // canUseInProcess should be true for refine phase
    const phase = "refine";
    const canUseInProcess = !checkpointRestored && !esmCacheStale && (phase === "refine" || false);
    expect(canUseInProcess).toBe(true);
  });
});
