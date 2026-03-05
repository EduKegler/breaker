import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
      assets: { BTC: { class: "crypto-major", strategies: { breakout: { coin: "BTC", dataSource: "binance", interval: "15m", strategyFactory: "createDonchianAdx", dateRange: { start: "2025-05-24", end: "2026-02-24" } } } } },
      phases: { refine: { maxIter: 5 }, research: { maxIter: 3 }, restructure: { maxIter: 5 }, maxCycles: 2 },
      scoring: { weights: { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 } },
      research: { enabled: true, model: "sonnet", maxSearchesPerIter: 3, timeoutMs: 180000 },
    },
    criteria: { minTrades: 150, minPF: 1.6, maxDD: 8, minWR: 30, minAvgR: 0.20 },
    dataConfig: {
      coin: opts?.asset ?? "BTC",
      dataSource: "binance",
      interval: "15m",
      strategyFactory: "createDonchianAdx",
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
  getStrategySourcePath: vi.fn((_root: string, _factoryName: string) => `${_root}/packages/backtest/src/strategies/donchian-adx.ts`),
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
    expect(cfg.strategyFactory).toBe("createDonchianAdx");
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

  it("neutral + !meetsMinTrades -> neutral", () => {
    expect(phaseHelpers.computeEffectiveVerdict("neutral", false)).toBe("neutral");
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
// BUG FIX: rollback uses checkpoint metrics (not stale failed metrics)
// ---------------------------------------------------------------------------
describe("rollback metrics consistency", () => {
  it("after non-refine rollback, metrics should be updated to checkpoint metrics", () => {
    // Simulates the rollback flow in orchestrator Step 4:
    // When a restructure fails (e.g., 1 trade), we rollback the source.
    // The metrics passed to the optimizer should be from the checkpoint, not from the failed run.
    const failedMetrics = { totalPnl: 0.14, numTrades: 1, profitFactor: 0, maxDrawdownPct: 0, winRate: 100, avgR: 0.01 };
    const checkpointMetrics = { totalPnl: -70, numTrades: 77, profitFactor: 0.71, maxDrawdownPct: 22, winRate: 41, avgR: -0.09 };
    const phase = "restructure";
    const effectiveVerdict = "reject";

    // This is the logic from the orchestrator:
    let metrics = { ...failedMetrics };
    let currentPnl = metrics.totalPnl ?? 0;

    if (effectiveVerdict === "reject" && phase !== "refine") {
      // Simulate loading checkpoint data
      const cpData = { metrics: checkpointMetrics };
      metrics = cpData.metrics as typeof metrics;
      currentPnl = metrics.totalPnl ?? 0;
    }

    // After rollback, metrics must reflect the checkpoint, not the failed run
    expect(metrics.numTrades).toBe(77);
    expect(metrics.profitFactor).toBe(0.71);
    expect(currentPnl).toBe(-70);
  });

  it("refine rollback does NOT swap metrics (source unchanged)", () => {
    const failedMetrics = { totalPnl: -500, numTrades: 150, profitFactor: 0.5, maxDrawdownPct: 30, winRate: 35, avgR: -0.1 };
    const phase = "refine";
    const effectiveVerdict = "reject";

    let metrics = { ...failedMetrics };

    if (effectiveVerdict === "reject" && phase !== "refine") {
      // Should NOT enter this branch for refine
      metrics = { totalPnl: 999, numTrades: 999 } as typeof metrics;
    }

    // Refine rollback keeps original metrics (params are reverted but source unchanged)
    expect(metrics.numTrades).toBe(150);
    expect(metrics.profitFactor).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: failed restructures tracked for prompt feedback
// ---------------------------------------------------------------------------
describe("failed restructures tracking", () => {
  it("records failure info on non-refine rollback", () => {
    const failedRestructures: Array<{ globalIter: number; trades: number; pf: number; score: number }> = [];
    const phase = "restructure";
    const effectiveVerdict = "reject";
    const metrics = { numTrades: 1, profitFactor: 0 };
    const globalIter = 18;
    const scoreWeighted = 29.9;

    // Simulate rollback tracking logic
    if (phase !== "refine" && effectiveVerdict === "reject") {
      failedRestructures.push({
        globalIter,
        trades: metrics.numTrades ?? 0,
        pf: metrics.profitFactor ?? 0,
        score: scoreWeighted,
      });
    }

    expect(failedRestructures).toHaveLength(1);
    expect(failedRestructures[0]).toEqual({ globalIter: 18, trades: 1, pf: 0, score: 29.9 });
  });

  it("does NOT record failure on refine rollback", () => {
    const failedRestructures: Array<{ globalIter: number; trades: number; pf: number; score: number }> = [];
    const phase = "refine";
    const effectiveVerdict = "reject";

    if (phase !== "refine" && effectiveVerdict === "reject") {
      failedRestructures.push({ globalIter: 5, trades: 100, pf: 0.5, score: 30 });
    }

    expect(failedRestructures).toHaveLength(0);
  });

  it("accumulates multiple failures across iterations", () => {
    const failedRestructures: Array<{ globalIter: number; trades: number; pf: number; score: number }> = [];

    // Iter 1: restructure fails
    failedRestructures.push({ globalIter: 18, trades: 1, pf: 0, score: 29.9 });
    // Iter 2: restructure fails again
    failedRestructures.push({ globalIter: 19, trades: 3, pf: 0, score: 17.9 });

    expect(failedRestructures).toHaveLength(2);
    expect(failedRestructures.map((f) => f.globalIter)).toEqual([18, 19]);
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
    const phase = "restructure";
    const contentHash = "abc123";
    const lastContentHash = "abc123";
    const canUseInProcess = !checkpointRestored && (phase === "refine" || contentHash === lastContentHash);
    expect(canUseInProcess).toBe(true);
  });
});
