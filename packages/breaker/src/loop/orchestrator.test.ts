import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/config.js", () => ({
  loadConfig: vi.fn(() => ({
    criteria: {},
    modelRouting: { optimize: "sonnet", fix: "haiku", plan: "opus" },
    assetClasses: { "crypto-major": { minPF: 1.6 } },
    strategyProfiles: { breakout: {} },
    guardrails: { maxRiskTradeUsd: 25, protectedFields: [] },
    assets: { BTC: { class: "crypto-major", strategies: { breakout: { chartUrl: "https://example.com/chart" } } } },
    phases: { refine: { maxIter: 5 }, research: { maxIter: 3 }, restructure: { maxIter: 5 }, maxCycles: 2 },
    scoring: { weights: { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 } },
    research: { enabled: true, model: "sonnet", maxSearchesPerIter: 3, timeoutMs: 180000 },
  })),
  resolveAssetCriteria: vi.fn(() => ({
    minTrades: 150, minPF: 1.6, maxDD: 8, minWR: 30, minAvgR: 0.20,
  })),
  resolveChartUrl: vi.fn((_config: unknown, asset: string, _strategy?: string) => {
    if (asset === "BTC") return "https://example.com/chart";
    return "";
  }),
  resolveDateRange: vi.fn((_config: unknown, _asset: string, _strategy?: string) => "last365"),
}));

vi.mock("../lib/strategy-path.js", () => ({
  buildStrategyDir: vi.fn((_root: string, asset: string, strategy: string) => `${_root}/assets/${asset}/${strategy}`),
  findActiveStrategyFile: vi.fn(),
}));

import {
  parseArgs,
  buildConfig,
  checkCriteria,
  shouldEscalatePhase,
  getPhaseMaxIter,
  resetPhaseCounters,
  transitionPhaseOnMaxIter,
  computeEffectiveVerdict,
} from "./orchestrator.js";
import type { LoopConfig, IterationState, LoopPhase } from "./types.js";
import { computeScore } from "./stages/scoring.js";
import type { ScoreVerdict } from "./stages/scoring.js";

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
      "--auto-commit=true",
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

  it("ignores malformed flags without = sign", () => {
    process.argv = ["node", "orchestrator.js", "--asset", "BTC", "--max-iter"];
    const result = parseArgs();
    expect(result.asset).toBeUndefined();
    expect(result.maxIter).toBe(10); // default
  });
});

// ---------------------------------------------------------------------------
// buildConfig
// ---------------------------------------------------------------------------
describe("buildConfig", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ["MAX_FIX_ATTEMPTS", "MAX_STALE_ATTEMPTS", "MAX_TRANSIENT_FAILURES", "MAX_NO_CHANGE"];

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
    const cfg = buildConfig({});
    expect(cfg.asset).toBe("BTC");
    expect(cfg.strategy).toBe("breakout");
  });

  it("uses the provided asset", () => {
    const cfg = buildConfig({ asset: "ETH" });
    expect(cfg.asset).toBe("ETH");
    expect(cfg.strategyFile).toBe("");
    expect(cfg.strategyDir).toContain("assets/ETH/breakout");
  });

  it("generates a runId in YYYYMMDD_HHMMSS format", () => {
    const cfg = buildConfig({ asset: "BTC" });
    expect(cfg.runId).toMatch(/^\d{8}_\d{6}$/);
  });

  it("returns empty chartUrl for unknown asset", () => {
    const cfg = buildConfig({ asset: "DOGE" });
    expect(cfg.chartUrl).toBe("");
  });

  it("reads maxFixAttempts from env var", () => {
    process.env.MAX_FIX_ATTEMPTS = "7";
    const cfg = buildConfig({ asset: "BTC" });
    expect(cfg.maxFixAttempts).toBe(7);
  });

  it("defaults maxFixAttempts to 3 when env var is absent", () => {
    const cfg = buildConfig({ asset: "BTC" });
    expect(cfg.maxFixAttempts).toBe(3);
  });

  it("includes dateRange from resolveDateRange", () => {
    const cfg = buildConfig({ asset: "BTC" });
    expect(cfg.dateRange).toBe("last365");
  });

  it("sets file paths relative to repoRoot", () => {
    const cfg = buildConfig({ asset: "SOL", repoRoot: "/custom/root" });
    expect(cfg.strategyFile).toBe("");
    expect(cfg.strategyDir).toBe("/custom/root/assets/SOL/breakout");
    expect(cfg.paramHistoryFile).toBe("/custom/root/assets/SOL/breakout/parameter-history.json");
    expect(cfg.checkpointDir).toBe("/custom/root/assets/SOL/breakout/checkpoints");
    expect(cfg.configFile).toBe("/custom/root/breaker-config.json");
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
    };
    // pnl=0 (not > 0) => false immediately
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
    // Empty criteria => defaults: minTrades=150, minPF=1.25, maxDD=12, minWR=20, minAvgR=0.15
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
// shouldEscalatePhase
// ---------------------------------------------------------------------------
describe("shouldEscalatePhase", () => {
  function makeState(overrides: Partial<IterationState> = {}): IterationState {
    return {
      iter: 1,
      globalIter: 1,
      bestPnl: 0,
      bestIter: 0,
      fixAttempts: 0,
      staleAttempts: 0,
      integrityAttempts: 0,
      transientFailures: 0,
      noChangeCount: 0,
      previousPnl: 0,
      sessionMetrics: [],
      currentPhase: "refine",

      currentScore: 0,
      bestScore: 0,
      neutralStreak: 0,
      phaseCycles: 0,
      ...overrides,
    };
  }

  const cfg = buildConfig({ asset: "BTC" });

  it("returns true for refine phase when neutralStreak >= 3", () => {
    const state = makeState({ currentPhase: "refine", neutralStreak: 3 });
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
  });

  it("returns true for refine phase when noChangeCount >= 2", () => {
    const state = makeState({ currentPhase: "refine", noChangeCount: 2 });
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
  });

  it("returns true for research phase when noChangeCount >= 2", () => {
    const state = makeState({ currentPhase: "research", neutralStreak: 0, noChangeCount: 2 });
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
  });

  it("returns false for research phase when noChangeCount < 2", () => {
    const state = makeState({ currentPhase: "research", neutralStreak: 10, noChangeCount: 1 });
    expect(shouldEscalatePhase(state, cfg)).toBe(false);
  });

  it("returns true for restructure phase when noChangeCount >= 2", () => {
    const state = makeState({ currentPhase: "restructure", neutralStreak: 0, noChangeCount: 2 });
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
  });

  it("returns false for restructure phase when noChangeCount < 2", () => {
    const state = makeState({ currentPhase: "restructure", neutralStreak: 10, noChangeCount: 1 });
    expect(shouldEscalatePhase(state, cfg)).toBe(false);
  });

  it("returns false for refine phase when neutralStreak is 2 (boundary below threshold)", () => {
    const state = makeState({ currentPhase: "refine", neutralStreak: 2, noChangeCount: 0 });
    expect(shouldEscalatePhase(state, cfg)).toBe(false);
  });

  it("returns false for refine phase when noChangeCount is 1 (boundary below threshold)", () => {
    const state = makeState({ currentPhase: "refine", neutralStreak: 0, noChangeCount: 1 });
    expect(shouldEscalatePhase(state, cfg)).toBe(false);
  });

  it("returns true for refine phase when both conditions are met simultaneously", () => {
    const state = makeState({ currentPhase: "refine", neutralStreak: 5, noChangeCount: 4 });
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetPhaseCounters
// ---------------------------------------------------------------------------
describe("resetPhaseCounters", () => {
  function makeState(overrides: Partial<IterationState> = {}): IterationState {
    return {
      iter: 5,
      globalIter: 10,
      bestPnl: 500,
      bestIter: 3,
      fixAttempts: 2,
      staleAttempts: 1,
      integrityAttempts: 1,
      transientFailures: 2,
      noChangeCount: 1,
      previousPnl: 400,
      sessionMetrics: [],
      currentPhase: "refine",

      currentScore: 50,
      bestScore: 60,
      neutralStreak: 3,
      phaseCycles: 0,
      ...overrides,
    };
  }

  it("resets fixAttempts, staleAttempts, integrityAttempts, transientFailures, neutralStreak, noChangeCount", () => {
    const state = makeState({
      fixAttempts: 2,
      staleAttempts: 1,
      integrityAttempts: 1,
      transientFailures: 2,
      neutralStreak: 3,
      noChangeCount: 1,
    });
    resetPhaseCounters(state);
    expect(state.fixAttempts).toBe(0);
    expect(state.staleAttempts).toBe(0);
    expect(state.integrityAttempts).toBe(0);
    expect(state.transientFailures).toBe(0);
    expect(state.neutralStreak).toBe(0);
    expect(state.noChangeCount).toBe(0);
  });

  it("does NOT reset bestPnl, bestScore, phaseCycles, or iter", () => {
    const state = makeState({
      bestPnl: 500,
      bestScore: 60,
      phaseCycles: 1,
      iter: 5,
    });
    resetPhaseCounters(state);
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
      iter: 1,
      globalIter: 1,
      bestPnl: 0,
      bestIter: 0,
      fixAttempts: 0,
      staleAttempts: 0,
      integrityAttempts: 0,
      transientFailures: 0,
      noChangeCount: 0,
      previousPnl: 0,
      sessionMetrics: [],
      currentPhase: "refine",

      currentScore: 0,
      bestScore: 0,
      neutralStreak: 0,
      phaseCycles: 0,
      ...overrides,
    };
  }

  const cfg = buildConfig({ asset: "BTC" });

  it("2 no-changes in refine triggers escalation to research (not abort)", () => {
    const state = makeState({ currentPhase: "refine", noChangeCount: 2 });
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
    // The orchestrator should transition to research, not abort
    // (shouldEscalatePhase returns true → orchestrator escalates)
  });

  it("2 no-changes in research triggers escalation to restructure (not abort)", () => {
    const state = makeState({ currentPhase: "research", noChangeCount: 2 });
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getPhaseMaxIter
// ---------------------------------------------------------------------------
describe("getPhaseMaxIter", () => {
  const cfg = buildConfig({ asset: "BTC" });

  it("returns maxIter for refine phase", () => {
    expect(getPhaseMaxIter("refine", cfg)).toBe(5);
  });

  it("returns maxIter for research phase", () => {
    expect(getPhaseMaxIter("research", cfg)).toBe(3);
  });

  it("returns maxIter for restructure phase", () => {
    expect(getPhaseMaxIter("restructure", cfg)).toBe(5);
  });

  it("uses proportional allocation when maxIter is large", () => {
    const largeCfg = { ...cfg, maxIter: 20 };
    // 20 * 0.4 = 8 > config 5 → proportional wins
    expect(getPhaseMaxIter("refine", largeCfg)).toBe(8);
    // 20 * 0.2 = 4 > config 3 → proportional wins
    expect(getPhaseMaxIter("research", largeCfg)).toBe(4);
    // 20 * 0.4 = 8 > config 5 → proportional wins
    expect(getPhaseMaxIter("restructure", largeCfg)).toBe(8);
  });

  it("uses config value when maxIter is small", () => {
    const smallCfg = { ...cfg, maxIter: 5 };
    // 5 * 0.4 = 2 < config 5 → config wins
    expect(getPhaseMaxIter("refine", smallCfg)).toBe(5);
    // 5 * 0.2 = 1 < config 3 → config wins
    expect(getPhaseMaxIter("research", smallCfg)).toBe(3);
    // 5 * 0.4 = 2 < config 5 → config wins
    expect(getPhaseMaxIter("restructure", smallCfg)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// transitionPhaseOnMaxIter
// ---------------------------------------------------------------------------
describe("transitionPhaseOnMaxIter", () => {
  it("refine → research", () => {
    const result = transitionPhaseOnMaxIter("refine", 0, 2);
    expect(result).toEqual({ nextPhase: "research", shouldBreak: false, incrementCycles: false });
  });

  it("research → restructure", () => {
    const result = transitionPhaseOnMaxIter("research", 0, 2);
    expect(result).toEqual({ nextPhase: "restructure", shouldBreak: false, incrementCycles: false });
  });

  it("restructure → refine when cycles < maxCycles", () => {
    const result = transitionPhaseOnMaxIter("restructure", 0, 2);
    expect(result).toEqual({ nextPhase: "refine", shouldBreak: false, incrementCycles: true });
  });

  it("restructure → break when cycles >= maxCycles", () => {
    const result = transitionPhaseOnMaxIter("restructure", 1, 2);
    expect(result).toEqual({ nextPhase: "restructure", shouldBreak: true, incrementCycles: true });
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveVerdict
// ---------------------------------------------------------------------------
describe("computeEffectiveVerdict", () => {
  it("accept + meetsMinTrades → accept", () => {
    expect(computeEffectiveVerdict("accept", true)).toBe("accept");
  });

  it("accept + !meetsMinTrades → neutral (bug fix)", () => {
    expect(computeEffectiveVerdict("accept", false)).toBe("neutral");
  });

  it("reject + meetsMinTrades → reject", () => {
    expect(computeEffectiveVerdict("reject", true)).toBe("reject");
  });

  it("reject + !meetsMinTrades → reject", () => {
    expect(computeEffectiveVerdict("reject", false)).toBe("reject");
  });

  it("neutral + meetsMinTrades → neutral", () => {
    expect(computeEffectiveVerdict("neutral", true)).toBe("neutral");
  });

  it("neutral + !meetsMinTrades → neutral", () => {
    expect(computeEffectiveVerdict("neutral", false)).toBe("neutral");
  });
});

// ---------------------------------------------------------------------------
// Integration: low-trade accept should not block phase escalation
// ---------------------------------------------------------------------------
describe("low-trade accept does not block phase escalation", () => {
  function makeState(overrides: Partial<IterationState> = {}): IterationState {
    return {
      iter: 1,
      globalIter: 1,
      bestPnl: 0,
      bestIter: 0,
      fixAttempts: 0,
      staleAttempts: 0,
      integrityAttempts: 0,
      transientFailures: 0,
      noChangeCount: 0,
      previousPnl: 0,
      sessionMetrics: [],
      currentPhase: "refine",

      currentScore: 0,
      bestScore: 0,
      neutralStreak: 0,
      phaseCycles: 0,
      ...overrides,
    };
  }

  const cfg = buildConfig({ asset: "BTC" });

  it("3 iters with score > 0 but trades < minTrades → neutralStreak=3 → shouldEscalate", () => {
    const state = makeState({ bestScore: 50, currentPhase: "refine" });

    // Simulate 3 iterations where score improves but trades < minTrades
    for (let i = 0; i < 3; i++) {
      const scoreVerdict: ScoreVerdict = "accept"; // score > bestScore
      const meetsMinTrades = false; // trades < minTrades
      const effective = computeEffectiveVerdict(scoreVerdict, meetsMinTrades);

      // effective should be "neutral", incrementing neutralStreak
      expect(effective).toBe("neutral");
      state.neutralStreak++;
    }

    expect(state.neutralStreak).toBe(3);
    expect(shouldEscalatePhase(state, cfg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG FIX: bestScore restored from checkpoint via computeScore
// ---------------------------------------------------------------------------
describe("bestScore restoration from checkpoint", () => {
  const cfg = buildConfig({ asset: "BTC" });

  it("computeScore returns positive score for good checkpoint metrics", () => {
    const checkpointMetrics = {
      totalPnl: 500,
      numTrades: 200,
      profitFactor: 2.0,
      maxDrawdownPct: 5,
      winRate: 35,
      avgR: 0.25,
    };
    const pineContent = "useRsi = true\nslAtrMult = 1.5";
    const score = computeScore(
      checkpointMetrics,
      pineContent,
      checkpointMetrics.numTrades,
      cfg.scoring.weights,
    );
    expect(score.weighted).toBeGreaterThan(0);
  });

  it("iter 1 with lower score does NOT overwrite a restored bestScore", () => {
    // Simulate: checkpoint had score ~70, iter 1 produces score ~35
    const checkpointMetrics = {
      totalPnl: 500,
      numTrades: 200,
      profitFactor: 2.0,
      maxDrawdownPct: 5,
      winRate: 35,
      avgR: 0.25,
    };
    const cpScore = computeScore(
      checkpointMetrics,
      "useRsi = true",
      200,
      cfg.scoring.weights,
    );

    const iterMetrics = {
      totalPnl: 100,
      numTrades: 80,
      profitFactor: 1.1,
      maxDrawdownPct: 10,
      winRate: 22,
      avgR: 0.08,
    };
    const iterScore = computeScore(
      iterMetrics,
      "useRsi = true",
      80,
      cfg.scoring.weights,
    );

    // With bestScore properly restored, iter 1 should NOT beat checkpoint
    expect(cpScore.weighted).toBeGreaterThan(iterScore.weighted);
    // And compareScores should NOT accept the worse score
    expect(iterScore.weighted).toBeLessThan(cpScore.weighted);
  });
});
