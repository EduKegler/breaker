/**
 * variant-switch.ts — Encapsulates the variant switch flow.
 *
 * Extracted from orchestrator.ts to eliminate duplication across
 * multiple variant-switch call sites (plateau, early kill, budget exhaustion).
 */

import fs from "node:fs";
import path from "node:path";
import { execaSync } from "execa";
import type { Candle, CandleInterval, Metrics, StrategyParam, TradeAnalysis } from "@breaker/backtest";
import { generateVariant } from "./variant-generator.js";
import { checkpoint } from "./stages/checkpoint.js";
import { computeScore } from "./stages/scoring.js";
import type { ScoreRaw } from "./stages/scoring.js";
import { runEngineInProcess } from "./stages/run-engine-in-process.js";
import type { VariantManager, VariantInfo } from "./variant-manager.js";
import type { LoopConfig } from "./types.js";
import type { ModuleContext } from "../lib/build-module-context.js";
import type { ScoringWeights } from "../types/config.js";

type StrategyFactory = (overrides?: Partial<Record<string, number>>) => import("@breaker/backtest").Strategy;

export interface SwitchToVariantOpts {
  cfg: LoopConfig;
  moduleContext: ModuleContext;
  variantManager: VariantManager;
  kbPath: string;
  seedStrategyFile: string;
  cancelSignal?: AbortSignal;
  currentMetrics: Metrics;
  currentAnalysis: TradeAnalysis | null;
  lastStrategyParams: Record<string, StrategyParam>;
  paramOverrides: Record<string, number>;
  currentScore: number;
  bestScore: number;
  globalIter: number;
  candles: Candle[];
  effectiveWarmupBars: number;
  scoringWeights?: Partial<ScoringWeights>;
}

export interface SwitchResult {
  variant: VariantInfo;
  factory: StrategyFactory;
  metrics: Metrics;
  analysis: TradeAnalysis | null;
  scoreResult: { weighted: number; raw: ScoreRaw; breakdown: string };
  paramOverrides: Record<string, number>;
  lastStrategyParams: Record<string, StrategyParam>;
  paramCount: number;
  pnl: number;
}

/**
 * Generate a new variant, rebuild, run baseline, and return all state needed
 * for the orchestrator to continue. Returns null if generation fails.
 */
export async function switchToNewVariant(opts: SwitchToVariantOpts): Promise<SwitchResult | null> {
  const {
    cfg, moduleContext, variantManager,
    kbPath, seedStrategyFile, cancelSignal,
    currentMetrics, currentAnalysis, lastStrategyParams, paramOverrides,
    currentScore, bestScore, globalIter,
    candles, effectiveWarmupBars, scoringWeights,
  } = opts;

  // Load checkpoint data for generation prompt
  const cpData = checkpoint.load(cfg.checkpointDir);
  const plateauMetrics = (cpData?.metrics ?? currentMetrics) as Metrics;
  const plateauAnalysis = cpData?.analysis ?? currentAnalysis;
  const plateauParams = cpData?.strategyParams ?? lastStrategyParams;
  const plateauParamOverrides = checkpoint.loadParams(cfg.checkpointDir) ?? paramOverrides;

  const newVariant = await generateVariant({
    cfg,
    moduleContext,
    variantManager,
    currentMetrics: plateauMetrics,
    currentAnalysis: plateauAnalysis as TradeAnalysis | null,
    lastStrategyParams: plateauParams,
    paramOverrides: plateauParamOverrides,
    currentScore,
    bestScore,
    globalIter,
    kbPath,
    seedStrategyFile,
    cancelSignal,
  });

  if (!newVariant) return null;

  // Override cfg paths with new variant
  cfg.strategyFile = newVariant.strategyFile;
  cfg.checkpointDir = newVariant.checkpointDir;
  cfg.paramHistoryFile = newVariant.paramHistoryFile;

  // Rebuild backtest package for new variant
  execaSync("pnpm", ["--filter", "@breaker/backtest", "build"], {
    cwd: path.resolve(cfg.repoRoot, "../.."),
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Reload factory from newly built variant
  const variantDistPath = cfg.strategyFile.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js");
  const variantMod = await import(variantDistPath) as Record<string, unknown>;
  const factoryKey = Object.keys(variantMod).find(k => typeof variantMod[k] === "function" && k.startsWith("create"));
  if (!factoryKey) throw new Error(`No create* factory found in ${variantDistPath}`);
  const factory = variantMod[factoryKey] as StrategyFactory;

  // Run baseline backtest
  const newParamOverrides: Record<string, number> = {};
  const strategy = factory(newParamOverrides);
  const newLastStrategyParams = strategy.params;
  const paramCount = Object.values(newLastStrategyParams).filter(p => p.optimizable).length;

  const source = fs.readFileSync(cfg.strategyFile, "utf8");
  const baseline = runEngineInProcess({
    candles,
    strategy,
    sourceInterval: cfg.interval as CandleInterval,
    warmupBars: effectiveWarmupBars,
  });

  const newMetrics = baseline.metrics;
  const newAnalysis = baseline.analysis;
  const pnl = newMetrics.totalPnl ?? 0;

  // Save baseline checkpoint
  checkpoint.save(cfg.checkpointDir, source, newMetrics, 0, newParamOverrides, baseline.trades, paramCount, newLastStrategyParams, newAnalysis ?? undefined);

  const scoreResult = computeScore(newMetrics, paramCount, newMetrics.numTrades ?? 0, scoringWeights);

  return {
    variant: newVariant,
    factory,
    metrics: newMetrics,
    analysis: newAnalysis,
    scoreResult,
    paramOverrides: newParamOverrides,
    lastStrategyParams: newLastStrategyParams,
    paramCount,
    pnl,
  };
}
