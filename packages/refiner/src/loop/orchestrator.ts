#!/usr/bin/env node
/**
 * orchestrator.ts — B.R.E.A.K.E.R. Orchestrator
 *
 * TypeScript strategy optimization loop backed by @breaker/backtest engine.
 * Runs in-process backtests (~2s) for refine phase, child-process (~5s) for restructure.
 *
 * Optimize-first loop: each iteration evaluates its own change in the same iteration.
 * Flow: Optimize → Apply → Backtest → Score → Checkpoint/Rollback
 *
 * Usage: node dist/loop/orchestrator.js --asset=BTC [--max-iter=10] [--phase=refine]
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { execaSync } from "execa";
import writeFileAtomic from "write-file-atomic";
import { createActor } from "xstate";

import { isMainModule, backoffDelay } from "@breaker/kit";
import { sendWhatsApp as sendWhatsAppWithRetry } from "@breaker/alerts";
import { getStrategySourcePath } from "../lib/get-strategy-source-path.js";
import { loadCandles } from "../lib/candle-loader.js";
import { buildBacktest } from "../lib/build-backtest.js";
import { classifyError } from "./classify-error.js";
import { parseArgs } from "./parse-args.js";
import { buildLoopConfig } from "./build-loop-config.js";
import { checkCriteria, checkStretchCriteria } from "./check-criteria.js";
import { phaseHelpers } from "./phase-helpers.js";
import { emitEvent, closeLoggers } from "./stages/events.js";
import { checkpoint } from "./stages/checkpoint.js";
import { validateParamGuardrails, validateWalkForward, validateRollingWalkForward, validateArchetypeWR, validateFreeVariableCount, validateStrategyStructure, validateProfitabilityRegression } from "./stages/guardrails.js";
import { buildSessionSummary, buildConsoleSummary } from "./stages/summary.js";
import type { VariantSummaryInfo } from "./stages/summary.js";
import { runEngineInProcess } from "./stages/run-engine-in-process.js";
import { runEngineChild } from "./stages/spawn-engine-child.js";
import { optimizeStrategy } from "./stages/optimize.js";
import { fixStrategy } from "./stages/fix-strategy.js";
import { integrity } from "./stages/integrity.js";
import { computeScore } from "./stages/scoring.js";
import type { ScoreRaw } from "./stages/scoring.js";
import { compareScores } from "./stages/compare-scores.js";
import { buildOptimizePrompt, validateSlugComponents } from "../automation/build-optimize-prompt.js";
import type { RestructureFailure } from "../automation/build-optimize-prompt.js";
import { buildFixPrompt } from "../automation/build-fix-prompt.js";
import { buildModuleContext, MODULE_CRITERIA, computeStretchCriteria, getKbSection, getStartingComponents } from "../lib/build-module-context.js";
import { paramWriter } from "./stages/param-writer.js";
import { conductResearch } from "./stages/research.js";
import { safeJsonParse } from "../lib/safe-json.js";
import { breakerMachine } from "./state-machine.js";
import { computeMinWarmupBars, intervalToMs } from "@breaker/backtest";
import type { Candle, CandleInterval, Metrics, Strategy, StrategyParam, TradeAnalysis } from "@breaker/backtest";
import type { IterationMetadata } from "./stages/param-writer.js";
import type { IterationState, LoopPhase } from "./types.js";
import { VariantManager } from "./variant-manager.js";
import { generateVariant } from "./variant-generator.js";
import { switchToNewVariant, switchToExistingVariant } from "./variant-switch.js";
import type { SwitchResult } from "./variant-switch.js";
import { generateSeed } from "./seed-generator.js";
import { applyRollback, applyB2Rollback } from "./loop-state.js";

// ---------------------------------------------------------------------------
// Graceful shutdown — Ctrl+C kills child processes and releases the lock
// ---------------------------------------------------------------------------

const shutdownController = new AbortController();

/**
 * Graceful cap: when set, the loop will finish the current iteration and
 * exit cleanly (summary, WhatsApp, checkpoint restore). Press 'q' to trigger.
 */
let gracefulCapRequested = false;

function installShutdownHandlers(asset: string): void {
  const handler = () => {
    // Prevent re-entrance on double Ctrl+C
    process.removeListener("SIGINT", handler);
    process.removeListener("SIGTERM", handler);
    console.log(`\n\x1b[33m⚠ Shutdown requested — cleaning up...\x1b[0m`);
    shutdownController.abort();
    try { closeLoggers(); } catch { /* best effort */ }
    process.exit(130); // 128 + SIGINT(2)
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);

  // Graceful cap: press 'q' to finish current iteration and exit cleanly
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      // Ctrl+C still works as before (raw mode captures it as \x03)
      if (key === "\x03") {
        handler();
        return;
      }
      if (key === "q" || key === "Q") {
        if (!gracefulCapRequested) {
          gracefulCapRequested = true;
          console.log(`\n\x1b[33m⚠ Graceful stop requested — finishing current iteration then exiting cleanly...\x1b[0m`);
        }
      }
    });
  }
}

/** Disable raw mode so the process can exit cleanly. */
function teardownStdin(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch { /* already closed */ }
  }
}

// ANSI color helpers (no dependency needed)
const c = {
  r: "\x1b[0m",      // reset
  b: "\x1b[1m",      // bold
  d: "\x1b[2m",      // dim
  red: "\x1b[31m",
  grn: "\x1b[32m",
  ylw: "\x1b[33m",
  blu: "\x1b[34m",
  mag: "\x1b[35m",
  cyn: "\x1b[36m",
};

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function log(msg: string): void {
  console.log(`${c.d}${ts()}${c.r} ${msg}`);
}

function logOk(msg: string): void {
  console.log(`${c.d}${ts()}${c.r} ${c.grn}${msg}${c.r}`);
}

function logWarn(msg: string): void {
  console.log(`${c.d}${ts()}${c.r} ${c.ylw}${msg}${c.r}`);
}

function logErr(msg: string): void {
  console.log(`${c.d}${ts()}${c.r} ${c.red}${msg}${c.r}`);
}

function logDim(msg: string): void {
  console.log(`${c.d}${ts()} ${msg}${c.r}`);
}

function fmtSummary(summary: string): string {
  return summary
    .replace(/\s*—\s*/g, "\n         — ")
    .replace(/;\s*/g, "\n         ; ");
}

function logIterHeader(iter: number, maxIter: number, phase: string, phaseIter: number, variantId?: string): void {
  const iterPart = `  Iteration ${String(iter).padStart(2)}/${maxIter}  │  phase: ${phase.padEnd(11)}  │  phaseIter: ${phaseIter}  `;
  const content = variantId ? `${iterPart}│  ${variantId}  ` : iterPart;
  const bar = "═".repeat(content.length);
  console.log("");
  console.log(`${c.b}${c.cyn}╔${bar}╗${c.r}`);
  console.log(`${c.b}${c.cyn}║${content}║${c.r}`);
  console.log(`${c.b}${c.cyn}╚${bar}╝${c.r}`);
}

/**
 * Count optimizable params in a strategy.
 */
function countOptimizableParams(params: Record<string, StrategyParam>): number {
  return Object.values(params).filter((p) => p.optimizable).length;
}

/**
 * Main orchestration entry point for the B.R.E.A.K.E.R. optimization loop.
 */
export async function orchestrate(): Promise<void> {
  // Load .env from package root (secrets: HL keys, WhatsApp credentials)
  dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env"), override: true });

  const startTime = Date.now();
  const partial = parseArgs();

  if (!partial.asset) {
    console.error("Usage: node orchestrator.js --asset=BTC [--strategy=breakout] [--max-iter=10] [--phase=refine]");
    process.exit(1);
  }

  const cfg = buildLoopConfig(partial);

  // Fail fast if WhatsApp notification is not configured
  const evoUrl = process.env.EVOLUTION_API_URL;
  const evoKey = process.env.EVOLUTION_API_KEY;
  const recipient = process.env.WHATSAPP_RECIPIENT;
  if (!evoUrl || !evoKey || !recipient) {
    const missing = [
      !evoUrl && "EVOLUTION_API_URL",
      !evoKey && "EVOLUTION_API_KEY",
      !recipient && "WHATSAPP_RECIPIENT",
    ].filter(Boolean).join(", ");
    console.error(`Missing required env vars for WhatsApp notifications: ${missing}`);
    process.exit(1);
  }

  log(`${c.b}B.R.E.A.K.E.R.${c.r} starting: asset=${c.b}${cfg.asset}${c.r} strategy=${cfg.strategy} maxIter=${cfg.maxIter} runId=${cfg.runId}`);
  logDim(`Press 'q' to gracefully stop after the current iteration`);

  // Build module context (strategy → KB module mapping)
  // cfg.repoRoot is the refiner package root; KB lives at monorepo root
  const monorepoRoot = path.resolve(cfg.repoRoot, "../..");
  const kbPath = path.join(monorepoRoot, "docs/knowledge-base.md");
  const moduleContext = buildModuleContext(cfg, kbPath);

  // Enforce KB §10.2: config must be at least as strict as KB module floors
  const kbFloor = MODULE_CRITERIA[moduleContext.moduleId];
  if (kbFloor) {
    if (cfg.criteria.minPF !== undefined && cfg.criteria.minPF < kbFloor.minPF) {
      logWarn(`KB floor override: minPF ${cfg.criteria.minPF} → ${kbFloor.minPF} (${moduleContext.moduleId})`);
      cfg.criteria.minPF = kbFloor.minPF;
    }
    if (cfg.criteria.maxDD !== undefined && cfg.criteria.maxDD > kbFloor.maxDD) {
      logWarn(`KB floor override: maxDD ${cfg.criteria.maxDD} → ${kbFloor.maxDD} (${moduleContext.moduleId})`);
      cfg.criteria.maxDD = kbFloor.maxDD;
    }
    if (cfg.criteria.minTrades !== undefined && cfg.criteria.minTrades < kbFloor.minTrades) {
      logWarn(`KB floor override: minTrades ${cfg.criteria.minTrades} → ${kbFloor.minTrades} (${moduleContext.moduleId})`);
      cfg.criteria.minTrades = kbFloor.minTrades;
    }
    if (kbFloor.minWR !== null && (cfg.criteria.minWR ?? 0) < kbFloor.minWR) {
      logWarn(`KB floor override: minWR ${cfg.criteria.minWR ?? 0} → ${kbFloor.minWR} (${moduleContext.moduleId})`);
      cfg.criteria.minWR = kbFloor.minWR;
    }
    if (kbFloor.minAvgR !== null && (cfg.criteria.minAvgR ?? 0) < kbFloor.minAvgR) {
      logWarn(`KB floor override: minAvgR ${cfg.criteria.minAvgR ?? 0} → ${kbFloor.minAvgR} (${moduleContext.moduleId})`);
      cfg.criteria.minAvgR = kbFloor.minAvgR;
    }
  }

  // Compute stretch targets (degradation-adjusted)
  const stretchTargets = computeStretchCriteria(moduleContext.moduleId);
  const degradationPct = (MODULE_CRITERIA[moduleContext.moduleId]?.expectedDegradation ?? 0.3) * 100;
  logDim(`Stretch targets: PF>=${stretchTargets.stretchPF}${stretchTargets.stretchAvgR ? ` avgR>=${stretchTargets.stretchAvgR}` : ""} (${degradationPct}% expected degradation)`);

  // Resolve seed strategy file.
  // Priority: variant registry (persisted) → config-derived path (backward compat) → generate from KB.
  const configSeedPath = getStrategySourcePath(cfg.repoRoot, cfg.strategyFactory, cfg.coin, cfg.strategy);
  cfg.strategyFile = configSeedPath;

  let seedGenerated = false;
  const registryPath = path.join(cfg.strategyDir, "variant-registry.json");
  if (fs.existsSync(registryPath)) {
    // Variant registry exists — check if its seed file is still on disk
    try {
      const reg = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { variants: { strategyFile: string }[] };
      const seedEntry = reg.variants[0];
      if (seedEntry?.strategyFile && fs.existsSync(seedEntry.strategyFile)) {
        cfg.strategyFile = seedEntry.strategyFile;
        logDim(`Seed resolved from variant registry: ${path.basename(seedEntry.strategyFile, ".ts")}`);
      }
    } catch { /* corrupt registry — fall through to config-derived check */ }
  }

  if (!fs.existsSync(cfg.strategyFile)) {
    const cpData = checkpoint.load(cfg.checkpointDir);
    if (cpData?.strategyContent) {
      fs.mkdirSync(path.dirname(cfg.strategyFile), { recursive: true });
      writeFileAtomic.sync(cfg.strategyFile, cpData.strategyContent);
      log(`${c.grn}Seed restored from checkpoint${c.r}`);
    } else {
      log(`${c.ylw}Seed not found — generating from KB starting point...${c.r}`);
      const monorepoRoot = path.resolve(cfg.repoRoot, "../..");
      const seedResult = await generateSeed({
        strategyDir: path.join(monorepoRoot, "packages", "backtest", "src", "strategies", cfg.coin.toLowerCase(), cfg.strategy),
        repoRoot: cfg.repoRoot,
        kbPath,
        kbSection: getKbSection(cfg.strategy),
        moduleContext,
        model: cfg.modelRouting.restructure ?? cfg.modelRouting.optimize,
        cancelSignal: shutdownController.signal,
      });
      cfg.strategyFile = seedResult.strategyFile;
      logOk(`Seed generated: ${seedResult.variantId} (${seedResult.factoryName})`);
    }
    await buildBacktest(cfg.repoRoot);
    seedGenerated = true;
  }
  const seedStrategyFile = cfg.strategyFile;

  // Factory resolved after variant management (see below) — needs to know which strategy is active
  type StrategyFactory = (overrides?: Partial<Record<string, number>>) => Strategy;
  let factory: StrategyFactory;

  // Ensure strategy dir exists
  if (!fs.existsSync(cfg.strategyDir)) {
    fs.mkdirSync(cfg.strategyDir, { recursive: true });
    logDim(`Created strategy dir: ${cfg.strategyDir}`);
  }

  installShutdownHandlers(cfg.asset);

  let success = false;

  // ---- Variant management ----
  const seedCheckpointDir = cfg.checkpointDir;
  const seedParamHistoryFile = cfg.paramHistoryFile;
  const variantMgr = new VariantManager(cfg.strategyDir, seedStrategyFile);
  const seedComponents = getStartingComponents(moduleContext.moduleId);
  variantMgr.loadOrInit(seedStrategyFile, seedCheckpointDir, seedParamHistoryFile, seedComponents);
  // Tracks when ESM module cache is stale (seed generated, variant switch, restructure).
  // Forces child-process backtest path since factory() would return old compiled code.
  let esmCacheStale = seedGenerated;
  let needsVariantGeneration = false;

  const activeVariant = variantMgr.getActive();
  if (activeVariant) {
    // Reset budget counter — each CLI run gives the active variant a fresh budget.
    // Without this, iterationsUsed from the previous run triggers immediate "Budget exhausted".
    variantMgr.resetBudget();
    variantMgr.save();
  }
  if (activeVariant && activeVariant.id !== path.basename(seedStrategyFile, ".ts")) {
    // Non-seed variant: override cfg paths
    cfg.strategyFile = activeVariant.strategyFile;
    cfg.checkpointDir = activeVariant.checkpointDir;
    cfg.paramHistoryFile = activeVariant.paramHistoryFile;
    esmCacheStale = true;
    log(`${c.b}Active variant: ${activeVariant.id}${c.r} (${activeVariant.strategyFile})`);
  } else if (!activeVariant) {
    // All variants plateaued/complete — check for user-queued active variants first
    const nextActive = variantMgr.findNextActive();
    if (nextActive) {
      variantMgr.reactivate(nextActive.id);
      variantMgr.save();
      cfg.strategyFile = nextActive.strategyFile;
      cfg.checkpointDir = nextActive.checkpointDir;
      cfg.paramHistoryFile = nextActive.paramHistoryFile;
      esmCacheStale = true;
      log(`Reactivating variant: ${c.b}${nextActive.id}${c.r}`);
    } else {
      needsVariantGeneration = true;
      log(`No active variant — will generate new variant after setup`);
    }
  }

  // 1g: Log variant switch decision
  const seedFilename = path.basename(seedStrategyFile);
  const activeFilenameForLog = path.basename(cfg.strategyFile);
  if (seedFilename !== activeFilenameForLog) {
    log(`Variant switch: seed=${seedFilename} → active=${activeFilenameForLog}`);
  } else {
    logDim(`Using seed strategy: ${seedFilename}`);
  }

  // Resolve strategy factory — always via dynamic import (no static registry)
  {
    const distPath = cfg.strategyFile.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js");
    const mod = await import(distPath) as Record<string, unknown>;
    const factoryKey = Object.keys(mod).find(k => typeof mod[k] === "function" && k.startsWith("create"));
    if (!factoryKey) throw new Error(`No create* factory found in ${distPath}`);
    factory = mod[factoryKey] as StrategyFactory;
    logDim(`Factory resolved via dynamic import: ${factoryKey} (${path.basename(cfg.strategyFile)})`);
  }

  // Load initial param overrides from checkpoint (need strategy to compute warmup)
  let paramOverrides: Record<string, number> = checkpoint.loadParams(cfg.checkpointDir) ?? {};

  // Warmup must cover ANY strategy the refiner might generate (restructure can change indicators).
  // Floor: 6000 bars (~62d of 15m) covers EMA 200 on 4h (3840 bars) with margin.
  const WARMUP_FLOOR = 6000;
  const initialStrategy = factory(paramOverrides);
  const computedWarmup = computeMinWarmupBars(initialStrategy, cfg.interval as CandleInterval);
  const warmupBars = Math.max(computedWarmup, WARMUP_FLOOR);
  const warmupMs = warmupBars * intervalToMs(cfg.interval as CandleInterval);
  const dataStartTime = cfg.startTime - warmupMs;
  logDim(`Warmup: ${warmupBars} bars (${Math.round(warmupMs / 86_400_000)}d) for indicator convergence`);

  // Load candles ONCE for the entire session (includes warmup period)
  logDim(`Syncing candles: ${cfg.coin}/${cfg.interval} from ${cfg.dataSource}...`);
  const candles: Candle[] = await loadCandles({
    coin: cfg.coin,
    source: cfg.dataSource,
    interval: cfg.interval,
    startTime: dataStartTime,
    endTime: cfg.endTime,
    dbPath: cfg.dbPath,
  });
  // Actual warmup bars based on loaded candles (may differ slightly from computed)
  const actualWarmupBars = candles.findIndex(c => c.t >= cfg.startTime);
  const effectiveWarmupBars = actualWarmupBars === -1 ? candles.length : actualWarmupBars;
  logDim(`Candles loaded: ${candles.length} bars (${effectiveWarmupBars} warmup + ${candles.length - effectiveWarmupBars} window)`);

  // ---- Variant generation (if previous variant plateaued) ----
  if (needsVariantGeneration) {
    // Load seed checkpoint metrics for the generation prompt
    let seedCheckpointData = checkpoint.load(seedCheckpointDir);

    // If seed has no checkpoint yet, run baseline backtest to produce real metrics
    if (!seedCheckpointData) {
      log(`${c.blu}Running seed baseline for variant generation prompt...${c.r}`);
      const seedSource = fs.readFileSync(seedStrategyFile, "utf8");
      const seedStrategy = factory({});
      const seedBaseline = runEngineInProcess({
        candles,
        strategy: seedStrategy,
        sourceInterval: cfg.interval as CandleInterval,
        warmupBars: effectiveWarmupBars,
      });
      const seedParamCount = countOptimizableParams(initialStrategy.params);
      checkpoint.save(seedCheckpointDir, seedSource, seedBaseline.metrics, 0, {}, seedBaseline.trades, seedParamCount, initialStrategy.params, seedBaseline.analysis ?? undefined);
      seedCheckpointData = { strategyContent: seedSource, metrics: seedBaseline.metrics, analysis: seedBaseline.analysis ?? undefined, strategyParams: initialStrategy.params, iter: 0, timestamp: new Date().toISOString() };
      logOk(`Seed baseline saved: PnL=$${(seedBaseline.metrics.totalPnl ?? 0).toFixed(2)} trades=${seedBaseline.metrics.numTrades}`);
    }

    const seedMetrics = (seedCheckpointData?.metrics ?? {}) as Metrics;
    const seedAnalysis = seedCheckpointData?.analysis ?? null;
    const seedParams = seedCheckpointData?.strategyParams ?? initialStrategy.params;
    const seedParamOverrides = checkpoint.loadParams(seedCheckpointDir) ?? {};
    const seedScore = seedCheckpointData
      ? computeScore(seedMetrics, countOptimizableParams(seedParams), seedMetrics.numTrades ?? 0, cfg.scoring.weights).weighted
      : 0;

    log(`${c.blu}${c.b}Generating new variant...${c.r}`);
    const newVariant = await generateVariant({
      cfg,
      moduleContext,
      variantManager: variantMgr,
      currentMetrics: seedMetrics,
      currentAnalysis: seedAnalysis as TradeAnalysis | null,
      lastStrategyParams: seedParams,
      paramOverrides: seedParamOverrides,
      currentScore: seedScore,
      bestScore: seedScore,
      globalIter: paramWriter.loadHistory(seedParamHistoryFile).iterations.length,
      kbPath,
      seedStrategyFile,
      cancelSignal: shutdownController.signal,
    });

    if (!newVariant) {
      logWarn("Variant generation failed — no more variants can be generated. Exiting.");
      variantMgr.save();
      process.exit(0);
    }

    // Override cfg paths with new variant
    cfg.strategyFile = newVariant.strategyFile;
    cfg.checkpointDir = newVariant.checkpointDir;
    cfg.paramHistoryFile = newVariant.paramHistoryFile;
    esmCacheStale = true;
    paramOverrides = {};
    logOk(`New variant active: ${c.b}${newVariant.id}${c.r}`);

    // Rebuild backtest package so child-process can import the new variant
    log(`${c.blu}Rebuilding @breaker/backtest for new variant...${c.r}`);
    await buildBacktest(cfg.repoRoot);
    logOk("Rebuild complete.");

    // Reload factory from newly built variant — prevents stale ESM cache from
    // returning the seed's strategy when factory() is called (no-op detection,
    // guardrails, in-process backtest). The variant's .js was never imported,
    // so Node's ESM cache doesn't interfere.
    const variantDistPath = cfg.strategyFile.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js");
    const variantMod = await import(variantDistPath) as Record<string, unknown>;
    const variantFactoryKey = Object.keys(variantMod).find(k => typeof variantMod[k] === "function" && k.startsWith("create"));
    if (!variantFactoryKey) throw new Error(`No create* factory found in ${variantDistPath}`);
    factory = variantMod[variantFactoryKey] as StrategyFactory;
    esmCacheStale = false; // Factory is fresh — in-process paths are safe
    logDim(`Factory reloaded for variant: ${variantFactoryKey} (${path.basename(cfg.strategyFile)})`);
  }

  // Determine initial phase: CLI flag overrides, otherwise always start from refine.
  // Previous sessions may have ended in restructure, but a fresh run should re-evaluate
  // from refine and escalate organically if refine plateaus.
  const existingHistory = paramWriter.loadHistory(cfg.paramHistoryFile)
  const initialPhase: LoopPhase = (partial as { initialPhase?: LoopPhase }).initialPhase || "refine";
  // After variant generation, factory may have been reloaded — use fresh factory
  // instead of stale initialStrategy (which was created from the seed factory).
  let lastStrategyParams = factory(paramOverrides).params;
  let paramCount = countOptimizableParams(lastStrategyParams);

  // F8: Track last analysis for fallback in prompt after rollback
  let lastAnalysis: TradeAnalysis | null = null;

  // Load existing checkpoint to seed best scores
  let initialBestPnl = 0;
  let initialBestIter = 0;
  let initialBestScore = 0;
  let bestScoreBreakdown: ScoreRaw | undefined;
  let initialMetrics: Metrics = {} as Metrics;
  let initialScoreResult: { weighted: number; raw: ScoreRaw; breakdown: string } = { weighted: 0, raw: {} as ScoreRaw, breakdown: "" };
  const existingCheckpoint = checkpoint.load(cfg.checkpointDir);
  let checkpointRestored = false;
  if (existingCheckpoint) {
    // Validate checkpoint source matches current strategy source.
    // If they differ (e.g., git checkout reverted the file), restore checkpoint source
    // and rebuild dist/ so the in-process backtest matches checkpoint metrics.
    const currentSource = fs.readFileSync(cfg.strategyFile, "utf8");
    const cpSourceHash = integrity.computeHash(existingCheckpoint.strategyContent);
    const currentHash = integrity.computeHash(currentSource);
    if (cpSourceHash !== currentHash && existingCheckpoint.iter > 0) {
      logWarn(`Checkpoint source hash mismatch: checkpoint=${cpSourceHash} current=${currentHash} (iter ${existingCheckpoint.iter})`);
      const rollbackOk = checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
      if (rollbackOk) {
        logOk("Checkpoint source restored successfully.");
      } else {
        logErr("Checkpoint rollback failed — no checkpoint file found.");
      }
      checkpointRestored = true;
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter: 0,
        stage: "CHECKPOINT_RESTORED", status: "warn",
        message: `Source hash mismatch: cp=${cpSourceHash} vs current=${currentHash}. Restored from iter ${existingCheckpoint.iter}.`,
      });
    } else if (existingCheckpoint) {
      logDim(`Checkpoint source matches current file (hash=${currentHash})`);
    }

    initialBestPnl = existingCheckpoint.metrics.totalPnl ?? 0;
    initialBestIter = existingCheckpoint.iter;
    lastAnalysis = existingCheckpoint.analysis ?? null;
    initialMetrics = existingCheckpoint.metrics as Metrics;
    const cpScore = computeScore(
      initialMetrics,
      paramCount,
      initialMetrics.numTrades ?? 0,
      cfg.scoring.weights,
    );
    initialBestScore = cpScore.weighted;
    bestScoreBreakdown = cpScore.raw;
    initialScoreResult = cpScore;
    logOk(`Loaded checkpoint: bestPnl=$${initialBestPnl.toFixed(2)} score=${initialBestScore.toFixed(1)} from iter ${initialBestIter}`);
  } else {
    // No checkpoint — run baseline backtest and save with real metrics.
    // This ensures bestScore reflects the actual strategy performance, preventing
    // the WF guardrail from trapping the loop when bestScore=0 causes every
    // positive-scoring iteration to be "accepted" then immediately WF-rejected.
    const baselineSource = fs.readFileSync(cfg.strategyFile, "utf8");
    log(`${c.blu}Running baseline backtest${esmCacheStale ? " (child-process)" : ""}...${c.r}`);
    let baselineResult;
    if (esmCacheStale) {
      // ESM cache stale: factory() may return stale code or wrong strategy.
      // Use child-process with dynamic import to load the current compiled code.
      const strategyDistPath = cfg.strategyFile.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js");
      baselineResult = runEngineChild({
        repoRoot: cfg.repoRoot,
        factoryName: cfg.strategyFactory,
        strategyFilePath: strategyDistPath,
        paramOverrides,
        dbPath: cfg.dbPath,
        coin: cfg.coin,
        source: cfg.dataSource,
        interval: cfg.interval,
        startTime: dataStartTime,
        endTime: cfg.endTime,
        warmupBars: effectiveWarmupBars,
      });
      if (baselineResult.paramCount != null) paramCount = baselineResult.paramCount;
      if (baselineResult.strategyParams) {
        lastStrategyParams = baselineResult.strategyParams as Record<string, import("@breaker/backtest").StrategyParam>;
      }
    } else {
      const baselineStrategy = factory(paramOverrides);
      baselineResult = runEngineInProcess({
        candles,
        strategy: baselineStrategy,
        sourceInterval: cfg.interval as CandleInterval,
        warmupBars: effectiveWarmupBars,
      });
    }
    initialMetrics = baselineResult.metrics;
    // F8: Save baseline analysis for the first iteration's prompt
    lastAnalysis = baselineResult.analysis;
    checkpoint.save(cfg.checkpointDir, baselineSource, initialMetrics, 0, paramOverrides, baselineResult.trades, paramCount, lastStrategyParams, lastAnalysis ?? undefined);

    initialBestPnl = initialMetrics.totalPnl ?? 0;
    const baselineScoreResult = computeScore(initialMetrics, paramCount, initialMetrics.numTrades ?? 0, cfg.scoring.weights);
    initialBestScore = baselineScoreResult.weighted;
    bestScoreBreakdown = baselineScoreResult.raw;
    initialScoreResult = baselineScoreResult;
    logOk(`Saved baseline checkpoint (iter 0): PnL=$${initialBestPnl.toFixed(2)} score=${initialBestScore.toFixed(1)} trades=${initialMetrics.numTrades}`);
  }

  // Check if baseline/checkpoint already passes all criteria.
  // If yes, don't stop on first criteria pass — run all iterations to maximize score.
  const baselinePassesCriteria = checkCriteria(initialMetrics, cfg.criteria, lastAnalysis?.walkForward ?? null, lastAnalysis?.rollingWalkForward ?? null);
  const baselinePassesStretch = baselinePassesCriteria && checkStretchCriteria(initialMetrics, cfg.criteria, stretchTargets.stretchPF, stretchTargets.stretchAvgR, lastAnalysis?.walkForward ?? null, lastAnalysis?.rollingWalkForward ?? null);
  if (baselinePassesStretch) {
    logOk(`Baseline already meets ALL stretch targets (PF=${(initialMetrics.profitFactor ?? 0).toFixed(2)} ≥ ${stretchTargets.stretchPF}) — nothing to optimize`);
  } else if (baselinePassesCriteria) {
    logOk(`Baseline already passes all criteria — will run all ${cfg.maxIter} iterations to maximize score`);
  }

  // Persistent metrics across iterations — seeded from baseline/checkpoint, updated by backtest+rollback
  let currentMetrics: Metrics = initialMetrics;
  let currentAnalysis: TradeAnalysis | null = lastAnalysis;
  let currentPnl = initialBestPnl;
  let currentScoreResult = initialScoreResult;

  // Create xstate actor for state management
  // If checkpoint was restored, set needsRebuild so first iteration uses child-process
  // path (ESM cache prevents factory() from picking up the rebuilt dist/).
  let actor = createActor(breakerMachine, {
    input: {
      initialPhase,
      maxCycles: cfg.phases.maxCycles,
      bestScore: initialBestScore,
      bestPnl: initialBestPnl,
      bestIter: initialBestIter,
      needsRebuild: checkpointRestored,
    },
  });
  actor.start();

  // State not managed by the machine (iteration tracking, session metrics)
  const state: IterationState = {
    iter: 0,
    globalIter: existingHistory.iterations.length,
    bestPnl: initialBestPnl,
    bestIter: initialBestIter,
    fixAttempts: 0,
    transientFailures: 0,
    noChangeCount: 0,
    previousPnl: initialBestPnl,
    sessionMetrics: [],
    currentPhase: initialPhase,
    currentScore: 0,
    bestScore: initialBestScore,
    neutralStreak: 0,
    phaseCycles: 0,
  };

  // Create artifacts dir
  if (!fs.existsSync(cfg.artifactsDir)) {
    fs.mkdirSync(cfg.artifactsDir, { recursive: true });
  }

  emitEvent({
    artifactsDir: cfg.artifactsDir,
    runId: cfg.runId,
    asset: cfg.asset,
    iter: 0,
    stage: "SESSION_START",
    status: "info",
    strategy: cfg.strategy,
    message: `strategy=${cfg.strategy} maxIter=${cfg.maxIter} bestPnl=${initialBestPnl} phase=${initialPhase}`,
  });

  let lastContentHash: string | undefined;
  let lastRollbackReason: string | undefined;
  let pendingVerdictOverride: { verdict: string; note: string } | undefined;
  /** Actual backtest metrics from the previous iteration — survives rollback.
   *  Without this, backfillLastIteration would use rolled-back checkpoint metrics,
   *  falsely reporting "no_trade_impact" for params that DID change results. */
  let lastActualBacktestMetrics: { pnl: number; trades: number; pf: number } | undefined;
  let failedRestructures: RestructureFailure[] = [];
  let bestPFEver = initialMetrics.profitFactor ?? 0;
  let bestAvgREver = initialMetrics.avgR ?? 0;
  /** Best metrics snapshot for dynamic budget computation — updated only on checkpoint save. */
  let bestVariantMetrics = {
    profitFactor: initialMetrics.profitFactor ?? 0,
    numTrades: initialMetrics.numTrades ?? 0,
    maxDrawdownPct: initialMetrics.maxDrawdownPct ?? 100,
    avgR: initialMetrics.avgR ?? 0,
    winRate: initialMetrics.winRate ?? 0,
  };
  /** Fingerprints of full param sets seen in this variant's lifetime. Detects historical repeats. */
  let seenParamFingerprints = new Set<string>();
  /** Recent rejected suggestions (no-op/repeat) — fed back into prompt so Claude doesn't repeat them. */
  let recentRejects: string[] = [];
  /** Validation warnings from previous iteration — fed back into prompt (var cap, clamped values, etc.) */
  let lastValidationWarnings: string[] = [];

  // ---- Global best tracking (across all variants) ----
  let globalBestScore = state.bestScore;
  let globalBestPnl = state.bestPnl;
  let globalBestIter = state.bestIter;
  let globalBestVariantId = variantMgr.getActive()?.id ?? "unknown";

  // ============================================================
  // OPTIMIZE-FIRST LOOP
  // Each iteration: Optimize → Apply → Backtest → Score → Checkpoint/Rollback
  // Baseline already ran in the pre-loop, seeding currentMetrics for the first prompt.
  // ============================================================
  if (baselinePassesStretch) {
    success = true;
    variantMgr.markComplete(initialBestScore, initialBestPnl, initialBestIter, 0);
    variantMgr.save();
  }

  for (let iter = 1; !baselinePassesStretch && iter <= cfg.maxIter; iter++) {
    // ---- Graceful cap check ----
    if (gracefulCapRequested) {
      log(`${c.ylw}Graceful stop: finishing after iteration ${iter - 1}${c.r}`);
      break;
    }

    state.iter = iter;
    state.globalIter++;

    // phaseIterCount is only incremented when a real change is confirmed
    // (deferred ITER_START — avoids inflating count for no-op/repeat iterations)
    const mCtx = actor.getSnapshot().context;
    const currentPhase = actor.getSnapshot().value as LoopPhase;
    logIterHeader(iter, cfg.maxIter, currentPhase, mCtx.phaseIterCount, variantMgr.getActive()?.id);

    // Sync IterationState from machine for backwards compat
    state.currentPhase = currentPhase;

    // ---- Phase escalation check ----
    const prevPhase = currentPhase;
    actor.send({ type: "ESCALATE" });
    let snap = actor.getSnapshot();
    const phaseAfterEscalation = snap.value as LoopPhase | "done";

    if (phaseAfterEscalation === "done") {
      logWarn(`Max phase cycles (${cfg.phases.maxCycles}) reached. Ending loop.`);
      break;
    }

    if (phaseAfterEscalation !== prevPhase) {
      log(`${c.b}${c.mag}⬆ Escalating: ${prevPhase} → ${phaseAfterEscalation}${c.r} | bestScore=${mCtx.bestScore.toFixed(1)} bestPnl=$${mCtx.bestPnl.toFixed(2)} bestIter=${mCtx.bestIter} (neutralStreak=${mCtx.neutralStreak}, noChange=${mCtx.noChangeCount}, wfReject=${mCtx.wfRejectStreak})`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "PHASE_CHANGE", status: "info",
        message: `${prevPhase} -> ${phaseAfterEscalation}`,
        escalationReason: `neutralStreak=${mCtx.neutralStreak}, noChangeCount=${mCtx.noChangeCount}, wfRejectStreak=${mCtx.wfRejectStreak}, phaseCycles=${mCtx.phaseCycles}`,
      });
    }

    // Check phase iter limits — only if ESCALATE didn't already transition (P1.4)
    const activePhase = snap.value as LoopPhase;
    const phaseMaxIter = phaseHelpers.getMaxIter(activePhase, cfg);
    if (phaseAfterEscalation === prevPhase && snap.context.phaseIterCount > phaseMaxIter) {
      const prevPhase2 = activePhase;
      actor.send({ type: "PHASE_TIMEOUT" });
      snap = actor.getSnapshot();
      const phaseAfterTimeout = snap.value as LoopPhase | "done";

      if (phaseAfterTimeout === "done") {
        logWarn(`Max phase cycles (${cfg.phases.maxCycles}) reached.`);
        break;
      }

      log(`${c.b}${c.mag}${prevPhase2}${c.r} phase complete (${phaseMaxIter} iters). Transitioning to ${c.b}${c.mag}${phaseAfterTimeout}${c.r}.`);
    }

    // Read fresh state from actor
    snap = actor.getSnapshot();
    const phase = snap.value as LoopPhase;
    state.currentPhase = phase;

    // Variant plateau detection: when refine escalates to research/restructure,
    // mark the variant as plateaued. Instead of ending the run, generate a new
    // variant and continue with remaining iterations (outer loop).
    if (prevPhase === "refine" && phase !== "refine") {
      const activeVar = variantMgr.getActive();
      const reason = `neutralStreak=${mCtx.neutralStreak}, noChange=${mCtx.noChangeCount}, wfReject=${mCtx.wfRejectStreak}`;
      variantMgr.markPlateaued(reason, mCtx.bestScore, mCtx.bestPnl, mCtx.bestIter, iter - 1);
      variantMgr.save();
      logWarn(`Variant ${activeVar?.id ?? "?"} plateaued (${reason}).`);

      // ---- Outer loop: try reactivating queued variant, else generate new ----
      const remaining = cfg.maxIter - iter;
      let switchResult: SwitchResult | null = null;

      const nextActivePlateau = variantMgr.findNextActive();
      if (nextActivePlateau) {
        log(`${c.blu}${c.b}Reactivating queued variant: ${nextActivePlateau.id} (${remaining} iterations remaining)...${c.r}`);
        switchResult = await switchToExistingVariant({
          cfg, variantManager: variantMgr, variant: nextActivePlateau,
          candles, effectiveWarmupBars, scoringWeights: cfg.scoring.weights,
        });
        if (switchResult) {
          logOk(`Reactivated variant: ${c.b}${nextActivePlateau.id}${c.r} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`);
        } else {
          logWarn(`Failed to reactivate ${nextActivePlateau.id} — falling back to generation`);
        }
      }

      if (!switchResult) {
        log(`${c.blu}${c.b}Generating new variant (${remaining} iterations remaining)...${c.r}`);
        for (let attempt = 0; attempt < 2; attempt++) {
          switchResult = await switchToNewVariant({
            cfg,
            moduleContext,
            variantManager: variantMgr,
            kbPath,
            seedStrategyFile,
            cancelSignal: shutdownController.signal,
            currentMetrics,
            currentAnalysis,
            lastStrategyParams,
            paramOverrides,
            currentScore: state.bestScore,
            bestScore: state.bestScore,
            globalIter: state.globalIter,
            candles,
            effectiveWarmupBars,
            scoringWeights: cfg.scoring.weights,
          });
          if (switchResult) break;
          logWarn(`Variant generation attempt ${attempt + 1} failed — ${attempt === 0 ? "retrying..." : "giving up."}`);
        }
      }
      if (!switchResult) {
        logWarn("Catalog may be exhausted — exiting loop.");
        break;
      }

      // Apply result to orchestrator state
      factory = switchResult.factory;
      esmCacheStale = false;
      checkpointRestored = false;
      paramOverrides = switchResult.paramOverrides;
      lastStrategyParams = switchResult.lastStrategyParams;
      paramCount = switchResult.paramCount;
      currentMetrics = switchResult.metrics;
      currentAnalysis = switchResult.analysis;
      lastAnalysis = switchResult.analysis;
      currentPnl = switchResult.pnl;
      bestScoreBreakdown = switchResult.scoreResult.raw;
      currentScoreResult = switchResult.scoreResult;
      logOk(`New variant: ${c.b}${switchResult.variant.id}${c.r} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`);

      // Reset loop state for new variant
      success = false;
      lastRollbackReason = undefined;
      failedRestructures = [];
      lastContentHash = undefined;
      pendingVerdictOverride = undefined;
      lastActualBacktestMetrics = undefined;
      bestPFEver = currentMetrics.profitFactor ?? 0;
      bestAvgREver = currentMetrics.avgR ?? 0;
      bestVariantMetrics = {
        profitFactor: currentMetrics.profitFactor ?? 0,
        numTrades: currentMetrics.numTrades ?? 0,
        maxDrawdownPct: currentMetrics.maxDrawdownPct ?? 100,
        avgR: currentMetrics.avgR ?? 0,
        winRate: currentMetrics.winRate ?? 0,
      };
      seenParamFingerprints = new Set<string>();
      recentRejects = [];
      lastValidationWarnings = [];

      state.bestScore = switchResult.scoreResult.weighted;
      state.bestPnl = switchResult.pnl;
      state.bestIter = 0;
      state.previousPnl = switchResult.pnl;
      state.currentScore = switchResult.scoreResult.weighted;
      if (switchResult.scoreResult.weighted > globalBestScore) {
        globalBestScore = switchResult.scoreResult.weighted;
        globalBestPnl = switchResult.pnl;
        globalBestIter = iter;
        globalBestVariantId = switchResult.variant.id;
      }

      // Recreate actor with fresh state for new variant
      actor.stop();
      actor = createActor(breakerMachine, {
        input: {
          initialPhase: "refine",
          maxCycles: cfg.phases.maxCycles,
          bestScore: switchResult.scoreResult.weighted,
          bestPnl: switchResult.pnl,
          bestIter: 0,
        },
      });
      actor.start();

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "VARIANT_SWITCH", status: "info",
        message: `Switched to variant ${switchResult.variant.id} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`,
      });
      state.sessionMetrics.push({
        iter,
        variantId: switchResult.variant.id,
        pnl: switchResult.pnl,
        pf: switchResult.metrics.profitFactor ?? 0,
        dd: switchResult.metrics.maxDrawdownPct ?? 0,
        wr: switchResult.metrics.winRate ?? 0,
        trades: switchResult.metrics.numTrades ?? 0,
        avgR: switchResult.metrics.avgR ?? 0,
        verdict: "baseline",
      });
      continue;
    }

    // Detect restructure→refine via ESCALATE or PHASE_TIMEOUT (ESM cache staleness)
    if (prevPhase === "restructure" && phase === "refine") {
      esmCacheStale = true;
    }

    // ---- Per-variant budget check (dynamic) ----
    const variantItersUsed = variantMgr.getActive()?.iterationsUsed ?? 0;
    const effectiveBudget = phaseHelpers.computeEffectiveBudget({
      baseBudget: cfg.perVariantBudget,
      bestMetrics: bestVariantMetrics,
      criteria: {
        minPF: cfg.criteria.minPF ?? 1.3,
        minTrades: cfg.criteria.minTrades ?? 50,
        maxDD: cfg.criteria.maxDD ?? 10,
        minAvgR: cfg.criteria.minAvgR ?? null,
        minWR: cfg.criteria.minWR ?? null,
      },
    });
    if (variantItersUsed >= effectiveBudget) {
      const budgetReason = `Per-variant budget exhausted (${variantItersUsed}/${effectiveBudget})`;
      logWarn(budgetReason);
      variantMgr.markPlateaued(budgetReason, state.bestScore, state.bestPnl, state.bestIter, variantItersUsed);
      variantMgr.save();

      let switchResult: SwitchResult | null = null;

      const nextActiveBudget = variantMgr.findNextActive();
      if (nextActiveBudget) {
        log(`${c.blu}${c.b}Budget exhausted — reactivating queued variant: ${nextActiveBudget.id} (${cfg.maxIter - iter} iterations remaining)...${c.r}`);
        switchResult = await switchToExistingVariant({
          cfg, variantManager: variantMgr, variant: nextActiveBudget,
          candles, effectiveWarmupBars, scoringWeights: cfg.scoring.weights,
        });
        if (switchResult) {
          logOk(`Reactivated variant: ${c.b}${nextActiveBudget.id}${c.r} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`);
        } else {
          logWarn(`Failed to reactivate ${nextActiveBudget.id} — falling back to generation`);
        }
      }

      if (!switchResult) {
        log(`${c.blu}${c.b}Budget exhausted — generating new variant (${cfg.maxIter - iter} iterations remaining)...${c.r}`);
        for (let attempt = 0; attempt < 2; attempt++) {
          switchResult = await switchToNewVariant({
            cfg,
            moduleContext,
            variantManager: variantMgr,
            kbPath,
            seedStrategyFile,
            cancelSignal: shutdownController.signal,
            currentMetrics,
            currentAnalysis,
            lastStrategyParams,
            paramOverrides,
            currentScore: state.bestScore,
            bestScore: state.bestScore,
            globalIter: state.globalIter,
            candles,
            effectiveWarmupBars,
            scoringWeights: cfg.scoring.weights,
          });
          if (switchResult) break;
          logWarn(`Variant generation attempt ${attempt + 1} failed — ${attempt === 0 ? "retrying..." : "giving up."}`);
        }
      }
      if (!switchResult) {
        logWarn("Catalog may be exhausted — exiting loop.");
        break;
      }

      factory = switchResult.factory;
      esmCacheStale = false;
      checkpointRestored = false;
      paramOverrides = switchResult.paramOverrides;
      lastStrategyParams = switchResult.lastStrategyParams;
      paramCount = switchResult.paramCount;
      currentMetrics = switchResult.metrics;
      currentAnalysis = switchResult.analysis;
      lastAnalysis = switchResult.analysis;
      currentPnl = switchResult.pnl;
      bestScoreBreakdown = switchResult.scoreResult.raw;
      currentScoreResult = switchResult.scoreResult;
      logOk(`New variant: ${c.b}${switchResult.variant.id}${c.r} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`);

      success = false;
      lastRollbackReason = undefined;
      failedRestructures = [];
      lastContentHash = undefined;
      pendingVerdictOverride = undefined;
      lastActualBacktestMetrics = undefined;
      bestPFEver = currentMetrics.profitFactor ?? 0;
      bestAvgREver = currentMetrics.avgR ?? 0;
      bestVariantMetrics = {
        profitFactor: currentMetrics.profitFactor ?? 0,
        numTrades: currentMetrics.numTrades ?? 0,
        maxDrawdownPct: currentMetrics.maxDrawdownPct ?? 100,
        avgR: currentMetrics.avgR ?? 0,
        winRate: currentMetrics.winRate ?? 0,
      };
      seenParamFingerprints = new Set<string>();
      recentRejects = [];
      lastValidationWarnings = [];

      state.bestScore = switchResult.scoreResult.weighted;
      state.bestPnl = switchResult.pnl;
      state.bestIter = 0;
      state.previousPnl = switchResult.pnl;
      state.currentScore = switchResult.scoreResult.weighted;
      if (switchResult.scoreResult.weighted > globalBestScore) {
        globalBestScore = switchResult.scoreResult.weighted;
        globalBestPnl = switchResult.pnl;
        globalBestIter = iter;
        globalBestVariantId = switchResult.variant.id;
      }

      actor.stop();
      actor = createActor(breakerMachine, {
        input: {
          initialPhase: "refine",
          maxCycles: cfg.phases.maxCycles,
          bestScore: switchResult.scoreResult.weighted,
          bestPnl: switchResult.pnl,
          bestIter: 0,
        },
      });
      actor.start();

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "VARIANT_SWITCH", status: "info",
        message: `Budget exhausted → variant ${switchResult.variant.id} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`,
      });
      state.sessionMetrics.push({
        iter,
        variantId: switchResult.variant.id,
        pnl: switchResult.pnl,
        pf: switchResult.metrics.profitFactor ?? 0,
        dd: switchResult.metrics.maxDrawdownPct ?? 0,
        wr: switchResult.metrics.winRate ?? 0,
        trades: switchResult.metrics.numTrades ?? 0,
        avgR: switchResult.metrics.avgR ?? 0,
        verdict: "baseline",
      });
      continue;
    }

    const iterStartMs = Date.now();

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "ITER_START", status: "info",
      message: `phase=${phase} budget=${variantItersUsed}/${effectiveBudget}`,
    });

    // ---- Research stage (if in research phase, plateau-strong policy) ----
    const researchBriefPath = snap.context.researchBriefPath;
    const finishedVariantCount = variantMgr.getAll().filter(
      (v) => v.status === "plateaued" || v.status === "killed",
    ).length;
    if (phase === "research" && cfg.research.enabled && !researchBriefPath && finishedVariantCount < 2) {
      logDim(`Skipping research — only ${finishedVariantCount} variant(s) finished (plateau-strong policy: need >=2)`);
    } else if (phase === "research" && cfg.research.enabled && !researchBriefPath && finishedVariantCount >= 2) {
      log(`${c.blu}🔬 Conducting research...${c.r}`);
      const exhaustedApproaches = (existingHistory.approaches ?? [])
        .filter((a) => a.verdict === "exhausted")
        .map((a) => a.name);

      const lastMetric = state.sessionMetrics.length > 0 ? state.sessionMetrics[state.sessionMetrics.length - 1] : null;

      const researchResult = await conductResearch({
        asset: cfg.asset,
        moduleContext,
        cancelSignal: shutdownController.signal,
        currentMetrics: {
          pnl: state.previousPnl,
          pf: lastMetric?.pf ?? 0,
          wr: lastMetric?.wr ?? 0,
          dd: lastMetric?.dd ?? 0,
          trades: lastMetric?.trades ?? 0,
          avgR: lastMetric?.avgR ?? 0,
        },
        failureHistory: failedRestructures.map((f) => ({
          approachName: `globalIter ${f.globalIter}`,
          failureMode: f.diagnosis ?? "score degraded",
          metrics: { pnl: 0, pf: f.pf, wr: 0, dd: 0, trades: f.trades, avgR: 0 },
        })),
        exhaustedApproaches,
        artifactsDir: cfg.artifactsDir,
        model: cfg.research.model,
        timeoutMs: cfg.research.timeoutMs,
        repoRoot: cfg.repoRoot,
        kbPath,
        allowedDomains: cfg.research.allowedDomains,
        criteria: cfg.criteria,
      });

      if (researchResult.success) {
        const briefPath = path.join(cfg.artifactsDir, "research-brief.json");
        actor.send({ type: "RESEARCH_DONE", briefPath });
        logOk(`🔬 Research complete: ${researchResult.data!.suggestedApproaches.length} approaches found`);
      } else {
        logWarn(`🔬 Research failed (non-blocking): ${researchResult.error}`);
      }
    }

    // ---- Backfill previous iteration's param-history (early, before any continue) ----
    // Uses lastActualBacktestMetrics (captured before rollback) so the "after" field
    // reflects the REAL backtest result, not rolled-back checkpoint metrics.
    // Falls back to currentMetrics for iterations that didn't run a backtest (e.g. no-op).
    try {
      const backfillMetrics = lastActualBacktestMetrics ?? {
        pnl: currentPnl,
        trades: currentMetrics.numTrades ?? 0,
        pf: currentMetrics.profitFactor ?? 0,
      };
      paramWriter.backfillLastIteration({
        historyPath: cfg.paramHistoryFile,
        currentMetrics: backfillMetrics,
        verdictOverride: pendingVerdictOverride,
      });
      pendingVerdictOverride = undefined;
      lastActualBacktestMetrics = undefined; // Consumed — reset for next iteration
    } catch (err) {
      logWarn(`Param-history backfill error (non-blocking): ${(err as Error).message}`);
    }

    // Snapshot pre-optimize metrics for param-writer's "before" field and comparison log
    const preOptimizeMetrics = {
      pnl: currentPnl,
      trades: currentMetrics.numTrades ?? 0,
      pf: currentMetrics.profitFactor ?? 0,
      wr: currentMetrics.winRate ?? 0,
      dd: currentMetrics.maxDrawdownPct ?? 0,
      avgR: currentMetrics.avgR ?? 0,
    };

    // Profitability regression baseline: use bestVariantMetrics (confirmed checkpoint)
    // to avoid contamination by NEUTRAL iterations whose metrics were never saved.
    // Fallback to preOptimizeMetrics for the first iteration (no checkpoint yet → defaults are 0).
    const profRegressionBaseline = {
      profitFactor: bestVariantMetrics.profitFactor || preOptimizeMetrics.pf,
      avgR: bestVariantMetrics.avgR || preOptimizeMetrics.avgR,
    };

    // ---- Step 1: Optimize (Claude suggests next changes) ----
    const phaseForOptimize = actor.getSnapshot().value as LoopPhase;
    const currentResearchBriefPath = actor.getSnapshot().context.researchBriefPath;
    const isRestructure = phaseForOptimize === "restructure" || !!currentResearchBriefPath;
    const optimizeModel = isRestructure && cfg.modelRouting.restructure
      ? cfg.modelRouting.restructure
      : cfg.modelRouting.optimize;
    const optimizeTimeout = isRestructure ? 1800000 : 900000;
    const effectivePhase = currentResearchBriefPath ? "restructure" : phaseForOptimize;

    log(`${c.blu}🤖 Optimizing${c.r} with ${c.b}${optimizeModel}${c.r} (phase=${effectivePhase}, timeout=${optimizeTimeout / 1000}s)...`);

    // Build prompt using persistent metrics (B4: use checkpoint strategyParams after restructure rollback)
    // For non-seed variants, lastStrategyParams already comes from child-process (correct variant params).
    // Only update from factory() when ESM cache is reliable (seed strategy, in-process path).
    if (!esmCacheStale) {
      const currentStrategy = factory(paramOverrides);
      lastStrategyParams = currentStrategy.params;
    }

    // 1a: Log param source and values sent to Claude
    const paramSource = esmCacheStale ? "child-process / checkpoint" : "factory()";
    logDim(`Params source: ${paramSource}`);
    if (lastStrategyParams) {
      const paramSummary = Object.entries(lastStrategyParams)
        .filter(([, p]) => p.optimizable)
        .map(([k, p]) => `${k}=${p.value}`)
        .join(", ");
      logDim(`Params sent to Claude: ${paramSummary || "(none)"}`);
    }
    if (Object.keys(paramOverrides).length > 0) {
      logDim(`Active overrides: ${JSON.stringify(paramOverrides)}`);
    }

    const prompt = buildOptimizePrompt({
      metrics: currentMetrics,
      tradeAnalysis: currentAnalysis ?? lastAnalysis,
      strategySourcePath: cfg.strategyFile,
      strategyParams: lastStrategyParams,
      paramOverrides,
      criteria: cfg.criteria,
      asset: cfg.asset,
      moduleContext,
      phase: effectivePhase,
      iter,
      maxIter: cfg.maxIter,
      globalIter: state.globalIter,
      paramHistoryPath: cfg.paramHistoryFile,
      artifactsDir: cfg.artifactsDir,
      researchBriefPath: currentResearchBriefPath,
      failedRestructures: failedRestructures.length > 0 ? failedRestructures : undefined,
      lastRollbackReason,
      scoreBreakdown: currentScoreResult.raw,
      scoringWeights: cfg.scoring.weights as import("../types/config.js").ScoringWeights,
      currentScore: currentScoreResult.weighted,
      bestScoreBreakdown,
      bestScore: actor.getSnapshot().context.bestScore,
      walkForward: (currentAnalysis ?? lastAnalysis)?.walkForward ?? null,
      rollingWalkForward: (currentAnalysis ?? lastAnalysis)?.rollingWalkForward ?? null,
      rejectedRepeats: recentRejects.length > 0 ? recentRejects : undefined,
      lastValidationWarnings: lastValidationWarnings.length > 0 ? lastValidationWarnings : undefined,
      startTime: cfg.startTime,
      endTime: cfg.endTime,
    });

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "OPTIMIZE_START", status: "info",
      message: `phase=${effectivePhase} promptChars=${prompt.length}`,
      model: optimizeModel,
      promptChars: prompt.length,
      approxPromptTokens: Math.round(prompt.length / 4),
      phase: effectivePhase,
    });

    const optimizeStartMs = Date.now();
    const optResult = await optimizeStrategy({
      prompt,
      strategyFile: cfg.strategyFile,
      repoRoot: cfg.repoRoot,
      model: optimizeModel,
      phase: effectivePhase,
      artifactsDir: cfg.artifactsDir,
      globalIter: state.globalIter,
      moduleContext,
      existingParamCount: paramCount,
      timeoutMs: optimizeTimeout,
      cancelSignal: shutdownController.signal,
    });

    const optSummary = optResult.data?.summary;

    // Log prompt metrics for observability
    const promptMetrics = {
      promptChars: optResult.data?.promptChars ?? prompt.length,
      approxTokens: optResult.data?.approxPromptTokens ?? Math.round(prompt.length / 4),
      claudeDurationMs: optResult.data?.claudeDurationMs ?? 0,
      maxTurns: optResult.data?.maxTurnsUsed ?? 0,
      actualTurns: optResult.data?.actualTurnsUsed ?? 0,
    };
    logDim(`Prompt: ${promptMetrics.promptChars} chars (~${promptMetrics.approxTokens} tokens) | Claude: ${Math.round(promptMetrics.claudeDurationMs / 1000)}s | turns: ${promptMetrics.actualTurns}/${promptMetrics.maxTurns}`);

    if (!optResult.success) {
      logErr(`🤖 Optimization failed: ${optResult.error?.slice(0, 200)}`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "OPTIMIZE_ERROR", status: "error",
        message: optResult.error?.slice(0, 100) || "unknown",
        phase: effectivePhase,
        claudeDurationMs: promptMetrics.claudeDurationMs,
        maxTurnsUsed: promptMetrics.maxTurns,
        actualTurnsUsed: promptMetrics.actualTurns,
      });
      continue;
    }

    // Capture validation warnings for feedback in next iteration's prompt
    lastValidationWarnings = optResult.data?.validationWarnings ?? [];

    if (!optResult.data?.changed) {
      actor.send({ type: "NO_CHANGE" });
      const noChangeCount = actor.getSnapshot().context.noChangeCount;
      logWarn(`⏸ No change (${noChangeCount}/${cfg.maxNoChange})${optSummary ? `\n         ${fmtSummary(optSummary)}` : ""}`);
      recentRejects.push("Claude returned no change");
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "NO_CHANGE", status: "info",
        message: optSummary?.slice(0, 200) || "no paramOverrides or file change",
        phase: effectivePhase,
        claudeDurationMs: promptMetrics.claudeDurationMs,
        maxTurnsUsed: promptMetrics.maxTurns,
        actualTurnsUsed: promptMetrics.actualTurns,
        verdict: "no_change",
      });
      if (noChangeCount >= cfg.maxNoChange) {
        logWarn(`No-change limit reached — will escalate phase at next iteration.`);
      }
      continue; // No change → skip backtest (same params/source)
    }

    logOk(`🤖 Optimization complete.${optSummary ? `\n         ${fmtSummary(optSummary)}` : ""}`);

    // ---- Step 2: Apply changes & guardrails ----
    if (effectivePhase === "refine" && optResult.data.paramOverrides) {
      // Refine: apply param overrides with guardrails check
      const newOverrides = { ...paramOverrides, ...optResult.data.paramOverrides };
      const newStrategy = factory(newOverrides);
      const beforeStrategy = factory(paramOverrides);

      const violations = validateParamGuardrails(
        beforeStrategy.params,
        newStrategy.params,
        cfg.guardrails,
      );

      if (violations.length > 0) {
        logWarn(`⛔ Guardrail violations: ${violations.map((v) => `${v.field}: ${v.reason}`).join("; ")}`);
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "GUARDRAIL_VIOLATION", status: "warn",
          message: violations.map((v) => `${v.field}: ${v.reason}`).join("; "),
        });
        continue;
      }

      // Detect no-op: optimizer returned values identical to current strategy
      const beforeValues = Object.fromEntries(
        Object.entries(beforeStrategy.params)
          .filter(([, p]) => p.optimizable)
          .map(([k, p]) => [k, p.value]),
      );
      const afterValues = Object.fromEntries(
        Object.entries(newStrategy.params)
          .filter(([, p]) => p.optimizable)
          .map(([k, p]) => [k, p.value]),
      );
      const actuallyChanged = Object.keys(afterValues).some((k) => afterValues[k] !== beforeValues[k]);
      if (!actuallyChanged) {
        // 1b: Log before/after when no actual change detected
        logDim(`No-op detected — before: ${JSON.stringify(beforeValues)}`);
        logDim(`No-op detected — after:  ${JSON.stringify(afterValues)}`);
        actor.send({ type: "NO_CHANGE" });
        const noChangeCount = actor.getSnapshot().context.noChangeCount;
        logWarn(`⏸ No change — params identical after apply (${noChangeCount}/${cfg.maxNoChange})`);
        const changedKeys = Object.keys(optResult.data!.paramOverrides!);
        recentRejects.push(`params identical after apply (${changedKeys.join(", ")})`);
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "NO_CHANGE", status: "info",
          message: "no-op: identical params",
          phase: effectivePhase,
          claudeDurationMs: promptMetrics.claudeDurationMs,
          verdict: "no_change",
        });
        if (noChangeCount >= cfg.maxNoChange) {
          logWarn(`No-change limit reached — will escalate phase at next iteration.`);
        }
        continue;
      }

      // Detect historical repeat: same full param set as a previous iteration
      const fingerprint = JSON.stringify(Object.entries(afterValues).sort(([a], [b]) => a.localeCompare(b)));
      if (seenParamFingerprints.has(fingerprint)) {
        logWarn(`⏸ Historical repeat — params identical to a previous iteration, skipping backtest`);
        actor.send({ type: "NO_CHANGE" });
        const noChangeCount = actor.getSnapshot().context.noChangeCount;
        logWarn(`  (noChangeCount=${noChangeCount}/${cfg.maxNoChange})`);
        // Build a readable summary of what was attempted
        const overrideEntries = Object.entries(optResult.data!.paramOverrides ?? {});
        const desc = overrideEntries.length > 0
          ? overrideEntries.map(([k, v]) => `${k}=${v}`).join(", ")
          : "same param set";
        recentRejects.push(`${desc} (historical repeat)`);
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "NO_CHANGE", status: "info",
          message: "historical repeat",
          phase: effectivePhase,
          claudeDurationMs: promptMetrics.claudeDurationMs,
          verdict: "no_change",
        });
        continue;
      }
      seenParamFingerprints.add(fingerprint);

      // Real change confirmed — now signal state machine
      actor.send({ type: "ITER_START" });
      actor.send({ type: "CHANGE_APPLIED", isRestructure: false });
      recentRejects = [];

      // 1b: Log which params changed with before→after
      for (const [k, v] of Object.entries(optResult.data.paramOverrides!)) {
        const prev = beforeValues[k];
        if (prev !== undefined && prev !== v) {
          log(`  Param changed: ${c.b}${k}${c.r} ${prev} → ${v}`);
        } else if (prev === undefined) {
          log(`  Param added: ${c.b}${k}${c.r} = ${v}`);
        }
      }
      paramOverrides = newOverrides;
    } else {
      // Restructure: file was changed + passed typecheck in optimize step
      actor.send({ type: "ITER_START" });
      actor.send({ type: "CHANGE_APPLIED", isRestructure: true });
      recentRejects = [];
      // needsRebuild set by CHANGE_APPLIED with isRestructure=true

      // Guardrail: ensure restructure didn't strip mandatory structural patterns
      const afterSource = fs.readFileSync(cfg.strategyFile, "utf8");
      const structureViolations = validateStrategyStructure(afterSource);
      if (structureViolations.length > 0) {
        logWarn(`⛔ Structural guardrail violations: ${structureViolations.map((v) => v.reason).join("; ")} — rejecting`);
        // Revert strategy file to checkpoint and clear needsRebuild so next
        // iteration doesn't run the rejected restructured code.
        checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
        actor.send({ type: "SET_NEEDS_REBUILD", value: false });
        logWarn("Reverted strategy to checkpoint after structural guardrail rejection");
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "GUARDRAIL_VIOLATION", status: "warn",
          message: structureViolations.map((v) => `${v.field}: ${v.reason}`).join("; "),
        });
        actor.send({ type: "VERDICT", verdict: "degraded" });
        failedRestructures.push({
          globalIter: state.globalIter,
          trades: 0,
          pf: 0,
          score: 0,
          diagnosis: `structural guardrail: ${structureViolations.map((v) => v.field).join(", ")}`,
        });
        logDim(`Tracked failed restructure (structural): globalIter=${state.globalIter} | ${structureViolations.map((v) => v.field).join(", ")}`);
        continue;
      }

      logDim(`Strategy source modified (restructure). Will rebuild before backtest.`);
    }

    // ---- Step 3: Read strategy content + compute hash (after apply) ----
    const strategyContent = fs.readFileSync(cfg.strategyFile, "utf8");
    const contentHash = integrity.computeHash(strategyContent);

    // ---- Step 4: Rebuild if needed (restructure phase) ----
    const needsRebuild = actor.getSnapshot().context.needsRebuild;
    if (needsRebuild) {
      log(`${c.blu}Rebuilding @breaker/backtest after restructure...${c.r}`);
      try {
        await buildBacktest(cfg.repoRoot);
        actor.send({ type: "SET_NEEDS_REBUILD", value: false });
        logOk("Rebuild complete.");
      } catch (err) {
        const errMsg = ((err as { stderr?: string }).stderr || (err as Error).message).slice(0, 300);
        logErr(`Build failed: ${errMsg}`);
        actor.send({ type: "COMPILE_ERROR" });
        if (actor.getSnapshot().context.fixAttempts > cfg.maxFixAttempts) {
          logErr(`Max fix attempts (${cfg.maxFixAttempts}) exceeded — rolling back to checkpoint`);
          checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
          actor.send({ type: "SET_NEEDS_REBUILD", value: false });
          const restoredSource = fs.readFileSync(cfg.strategyFile, "utf8");
          lastContentHash = integrity.computeHash(restoredSource);
          lastRollbackReason = `Build failed ${cfg.maxFixAttempts} times — rolled back to checkpoint`;
          continue;
        }

        // Try to fix the compilation error
        const fixPrompt = buildFixPrompt({
          strategySourcePath: cfg.strategyFile,
          errors: [],
          buildOutput: errMsg,
          moduleContext,
        });
        await fixStrategy({
          prompt: fixPrompt,
          strategyFile: cfg.strategyFile,
          repoRoot: cfg.repoRoot,
          model: cfg.modelRouting.fix,
          cancelSignal: shutdownController.signal,
        });
        continue;
      }
    }

    // ---- Step 5: Run backtest ----
    let engineResult;
    try {
      const canUseInProcess = !checkpointRestored && !esmCacheStale && (phase === "refine" || contentHash === lastContentHash);
      // 1d: Log backtest mode decision
      logDim(`Backtest mode: ${canUseInProcess ? "in-process" : "child-process"} (checkpointRestored=${checkpointRestored}, esmCacheStale=${esmCacheStale}, phase=${phase}, contentHashMatch=${contentHash === lastContentHash})`);
      if (canUseInProcess) {
        // In-process: fast path (~2s). Disabled when checkpoint source was restored
        // at startup (ESM cache means factory() still loads the old compiled code).
        const strategy = factory(paramOverrides);
        log(`${c.blu}Running in-process backtest${c.r} (params: ${JSON.stringify(paramOverrides)})...`);
        engineResult = runEngineInProcess({
          candles,
          strategy,
          sourceInterval: cfg.interval,
          warmupBars: effectiveWarmupBars,
        });
      } else {
        // Child process: needed after restructure edits (~5s) or for non-seed variants
        const strategyDistPath = esmCacheStale
          ? cfg.strategyFile.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js")
          : undefined;
        // 1c: Log child-process details
        log(`${c.blu}Running child-process backtest${c.r} (ESM cache stale)`);
        logDim(`  strategyFilePath: ${strategyDistPath ?? "(registry)"}`);
        if (Object.keys(paramOverrides).length > 0) {
          logDim(`  paramOverrides: ${JSON.stringify(paramOverrides)}`);
        }
        engineResult = runEngineChild({
          repoRoot: cfg.repoRoot,
          factoryName: cfg.strategyFactory,
          strategyFilePath: strategyDistPath,
          paramOverrides,
          dbPath: cfg.dbPath,
          coin: cfg.coin,
          source: cfg.dataSource,
          interval: cfg.interval,
          startTime: dataStartTime,
          endTime: cfg.endTime,
          warmupBars: effectiveWarmupBars,
        });
      }
    } catch (err) {
      const errClass = classifyError((err as Error).message || "");
      logErr(`Backtest failed: ${errClass} — ${(err as Error).message.slice(0, 200)}`);

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "BACKTEST_ERROR", status: "error",
        message: `${errClass}: ${(err as Error).message.slice(0, 100)}`,
      });

      if (errClass === "compile_error") {
        actor.send({ type: "COMPILE_ERROR" });
        const mCtxErr = actor.getSnapshot().context;
        if (mCtxErr.fixAttempts > cfg.maxFixAttempts) {
          logErr(`Max fix attempts (${cfg.maxFixAttempts}) exceeded — rolling back to checkpoint`);
          checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
          actor.send({ type: "SET_NEEDS_REBUILD", value: false });
          const restoredSource = fs.readFileSync(cfg.strategyFile, "utf8");
          lastContentHash = integrity.computeHash(restoredSource);
          lastRollbackReason = `Compile error persisted after ${cfg.maxFixAttempts} fix attempts — rolled back`;
          continue;
        }
        const fixPrompt = buildFixPrompt({
          strategySourcePath: cfg.strategyFile,
          errors: [],
          buildOutput: (err as Error).message,
          moduleContext,
        });
        logWarn(`Attempting fix (${mCtxErr.fixAttempts}/${cfg.maxFixAttempts})...`);
        await fixStrategy({
          prompt: fixPrompt,
          strategyFile: cfg.strategyFile,
          repoRoot: cfg.repoRoot,
          model: cfg.modelRouting.fix,
          cancelSignal: shutdownController.signal,
        });
        continue;
      }

      if (errClass === "timeout" || errClass === "network" || errClass === "transient") {
        actor.send({ type: "TRANSIENT_ERROR" });
        const mCtxErr = actor.getSnapshot().context;
        if (mCtxErr.transientFailures > cfg.maxTransientFailures) {
          logErr(`Max transient failures (${cfg.maxTransientFailures}) exceeded. Aborting.`);
          break;
        }
        // Rollback after repeated failures to recover from bad restructure
        if (mCtxErr.transientFailures >= 2) {
          const restored = checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
          if (restored) {
            logWarn("Rolled back to checkpoint after repeated transient failures");
            actor.send({ type: "SET_NEEDS_REBUILD", value: true });
            lastContentHash = undefined;
          }
        }
        const delay = backoffDelay(mCtxErr.transientFailures);
        logWarn(`Transient error (${mCtxErr.transientFailures}/${cfg.maxTransientFailures}). Waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      logErr(`Unrecoverable error. Aborting.`);
      break;
    }

    // ---- Step 6: Score + Verdict ----
    const metrics: Metrics = engineResult.metrics;
    const analysis: TradeAnalysis | null = engineResult.analysis;
    // F8: Persist analysis for fallback in next iteration if analysis gets nulled by rollback
    if (analysis) lastAnalysis = analysis;
    const engineTrades = engineResult.trades;
    const iterPnl = metrics.totalPnl ?? 0;

    // Track best PF and avgR ever seen for early kill checks (KB §13.2)
    bestPFEver = Math.max(bestPFEver, metrics.profitFactor ?? 0);
    bestAvgREver = Math.max(bestAvgREver, metrics.avgR ?? 0);

    // B3: Only recompute paramCount from factory() when ESM cache is reliable (in-process path).
    // For child-process path, use paramCount from the freshly-loaded strategy in the child.
    if ('paramCount' in engineResult && typeof engineResult.paramCount === 'number') {
      paramCount = engineResult.paramCount;
    } else {
      paramCount = countOptimizableParams(factory(paramOverrides).params);
    }
    // Update strategyParams from child-process (non-seed variants have different params than factory)
    if ('strategyParams' in engineResult && engineResult.strategyParams) {
      lastStrategyParams = engineResult.strategyParams as Record<string, import("@breaker/backtest").StrategyParam>;
    }

    // Compute score
    const scoreResult = computeScore(
      metrics,
      paramCount,
      metrics.numTrades ?? 0,
      cfg.scoring.weights,
    );

    actor.send({ type: "BACKTEST_OK", currentScore: scoreResult.weighted, currentPnl: iterPnl });
    lastContentHash = contentHash;

    // Capture actual backtest metrics BEFORE any rollback can reset them.
    // Used by backfillLastIteration to record the real result, not checkpoint metrics.
    lastActualBacktestMetrics = {
      pnl: iterPnl,
      trades: metrics.numTrades ?? 0,
      pf: metrics.profitFactor ?? 0,
    };

    // Update persistent variables with backtest result
    currentMetrics = metrics;
    currentAnalysis = analysis;
    currentPnl = iterPnl;
    currentScoreResult = scoreResult;

    // Comparison: before / after / target
    const cr = cfg.criteria;
    const pf = metrics.profitFactor ?? 0;
    const wr = metrics.winRate ?? 0;
    const dd = Math.abs(metrics.maxDrawdownPct ?? 0);
    const tr = metrics.numTrades ?? 0;
    const ar = metrics.avgR ?? 0;
    const pfC = pf >= (cr.minPF ?? 0) ? c.grn : c.red;
    const wrC = wr >= (cr.minWR ?? 0) ? c.grn : c.red;
    const ddC = dd <= (cr.maxDD ?? 100) ? c.grn : c.red;
    const trC = tr >= (cr.minTrades ?? 0) ? c.grn : c.red;
    const arC = ar >= (cr.minAvgR ?? 0) ? c.grn : c.red;
    logDim(`📊  best   │ PnL $${preOptimizeMetrics.pnl.toFixed(2).padStart(8)} │ PF ${preOptimizeMetrics.pf.toFixed(2).padStart(5)} │ WR ${preOptimizeMetrics.wr.toFixed(1).padStart(5)}% │ DD ${Math.abs(preOptimizeMetrics.dd).toFixed(1).padStart(5)}% │ T ${String(preOptimizeMetrics.trades).padStart(3)} │ avgR ${preOptimizeMetrics.avgR.toFixed(2).padStart(5)}`);
    log(`📊  ${c.b}now${c.r}    │ PnL $${iterPnl.toFixed(2).padStart(8)} │ PF ${pfC}${pf.toFixed(2).padStart(5)}${c.r} │ WR ${wrC}${wr.toFixed(1).padStart(5)}%${c.r} │ DD ${ddC}${dd.toFixed(1).padStart(5)}%${c.r} │ T ${trC}${String(tr).padStart(3)}${c.r} │ avgR ${arC}${ar.toFixed(2).padStart(5)}${c.r}`);
    logDim(`📊  target │ PnL          │ PF ${(cr.minPF ?? 0).toFixed(2).padStart(5)} │ WR ${(cr.minWR ?? 0).toFixed(1).padStart(5)}% │ DD ${(cr.maxDD ?? 0).toFixed(1).padStart(5)}% │ T ${String(cr.minTrades ?? 0).padStart(3)} │ avgR ${(cr.minAvgR ?? 0).toFixed(2).padStart(5)}`);
    logDim(`📊  ${c.ylw}stretch${c.r}${c.d} │ PnL          │ PF ${stretchTargets.stretchPF.toFixed(2).padStart(5)} │${stretchTargets.stretchAvgR !== null ? ` avgR ${stretchTargets.stretchAvgR.toFixed(2).padStart(5)} │` : ""} ~${degradationPct}% live degradation`);
    log(`📊 Score: ${c.b}${scoreResult.weighted.toFixed(1)}${c.r}/100`);

    const wf = analysis.walkForward;
    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "PARSE_DONE", status: "success",
      pnl: iterPnl, pf: metrics.profitFactor ?? 0,
      dd: metrics.maxDrawdownPct ?? 0, trades: metrics.numTrades ?? 0,
      message: `PnL=$${iterPnl.toFixed(2)} Score=${scoreResult.weighted.toFixed(1)}`,
      score: scoreResult.weighted,
      scoreBreakdown: scoreResult.raw,
      wr: metrics.winRate ?? 0,
      avgR: metrics.avgR ?? 0,
      ...(wf ? {
        trainPF: wf.trainPF ?? undefined,
        testPF: wf.testPF ?? undefined,
        pfRatio: wf.pfRatio ?? undefined,
        overfitFlag: wf.overfitFlag,
      } : {}),
    });

    // ---- Determine verdict using score ----
    const machCtx = actor.getSnapshot().context;
    const meetsMinTrades = (metrics.numTrades ?? 0) >= (cfg.criteria.minTrades ?? 0);
    const scoreVerdict = machCtx.bestScore > 0
      ? compareScores(scoreResult.weighted, machCtx.bestScore)
      : (scoreResult.weighted > 0 ? "accept" : "neutral");
    let effectiveVerdict = phaseHelpers.computeEffectiveVerdict(scoreVerdict, meetsMinTrades);

    // 1e: Log verdict with score comparison
    const verdictSymbol = effectiveVerdict === "accept" ? `${c.grn}✓ ACCEPT` : effectiveVerdict === "reject" ? `${c.red}✗ REJECT` : `${c.ylw}— NEUTRAL`;
    log(`Verdict: ${verdictSymbol}${c.r} (score=${scoreResult.weighted.toFixed(1)} vs best=${machCtx.bestScore.toFixed(1)}, raw=${scoreVerdict}${!meetsMinTrades ? ", minTrades not met" : ""})`);

    // B3: When effectiveVerdict overrides scoreVerdict, store note for param-history backfill
    if (!meetsMinTrades && scoreVerdict === "accept") {
      pendingVerdictOverride = {
        verdict: "neutral",
        note: `Score improved but trades=${metrics.numTrades ?? 0} < minTrades=${cfg.criteria.minTrades ?? 0}`,
      };
    }

    // Walk-forward overfit gate (KB §10.1): reject if strategy memorized training data
    const wfViolations = validateWalkForward(analysis.walkForward);
    if (wfViolations.length > 0 && effectiveVerdict === "accept") {
      logWarn(`⛔ Walk-forward overfit detected: ${wfViolations.map((v) => v.reason).join("; ")} — forcing reject`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "GUARDRAIL_VIOLATION", status: "warn",
        message: wfViolations.map((v) => v.reason).join("; "),
      });
      effectiveVerdict = "reject";
      actor.send({ type: "WF_REJECT" });
    }

    // Rolling walk-forward overfit gate: reject if majority of windows fail
    const rwfViolations = validateRollingWalkForward(analysis.rollingWalkForward);
    if (rwfViolations.length > 0 && effectiveVerdict === "accept") {
      logWarn(`⛔ Rolling walk-forward overfit detected: ${rwfViolations.map((v) => v.reason).join("; ")} — forcing reject`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "GUARDRAIL_VIOLATION", status: "warn",
        message: rwfViolations.map((v) => v.reason).join("; "),
      });
      effectiveVerdict = "reject";
      actor.send({ type: "WF_REJECT" });
    }

    // Free variable count gate (KB §13.1): reject if optimizable params exceed profile limit
    const fvViolations = validateFreeVariableCount(paramCount, cfg.criteria.maxFreeVariables);
    if (fvViolations.length > 0 && effectiveVerdict === "accept") {
      logWarn(`⛔ Free variable limit exceeded: ${fvViolations.map((v) => v.reason).join("; ")} — forcing reject`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "GUARDRAIL_VIOLATION", status: "warn",
        message: fvViolations.map((v) => v.reason).join("; "),
      });
      effectiveVerdict = "reject";
    }

    // Archetype WR drift gate: reject if WR exceeds module's hard max
    const wrViolations = validateArchetypeWR(
      metrics.winRate ?? 0,
      kbFloor?.wrRejectMax ?? null,
    );
    if (wrViolations.length > 0 && effectiveVerdict === "accept") {
      logWarn(`⛔ Archetype WR drift: ${wrViolations[0].reason} — forcing reject`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "GUARDRAIL_VIOLATION", status: "warn",
        message: wrViolations[0].reason,
      });
      effectiveVerdict = "reject";
    }

    // Profitability regression gate: reject when BOTH PF and avgR worsened vs best
    const profRegViolations = validateProfitabilityRegression(
      { profitFactor: metrics.profitFactor ?? null, avgR: metrics.avgR ?? null },
      { profitFactor: profRegressionBaseline.profitFactor, avgR: profRegressionBaseline.avgR },
    );
    if (profRegViolations.length > 0 && effectiveVerdict === "accept") {
      logWarn(`⛔ Profitability regression: ${profRegViolations[0].reason} — forcing reject`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "GUARDRAIL_VIOLATION", status: "warn",
        message: profRegViolations[0].reason,
      });
      effectiveVerdict = "reject";
    }

    let verdict: string;
    if (effectiveVerdict === "accept") {
      verdict = "improved";
      actor.send({ type: "VERDICT", verdict: "improved" });
    } else if (effectiveVerdict === "reject") {
      verdict = "degraded";
      actor.send({ type: "VERDICT", verdict: "degraded" });
    } else {
      verdict = "neutral";
      actor.send({ type: "VERDICT", verdict: "neutral" });
    }

    state.sessionMetrics.push({
      iter,
      variantId: variantMgr.getActive()?.id,
      pnl: iterPnl,
      pf: metrics.profitFactor ?? 0,
      dd: metrics.maxDrawdownPct ?? 0,
      wr: metrics.winRate ?? 0,
      trades: metrics.numTrades ?? 0,
      avgR: metrics.avgR ?? 0,
      verdict,
    });

    // ---- Step 7: Criteria check (includes WF overfitFlag per KB §10.1) ----
    // If baseline already passed criteria, don't stop early — run all iterations
    // to maximize score. Only stop early when going FROM failing TO passing.
    // With stretch targets: even when criteria pass, continue until stretch met.
    if (checkCriteria(metrics, cfg.criteria, analysis.walkForward, analysis.rollingWalkForward)) {
      success = true;
      const meetsStretch = checkStretchCriteria(metrics, cfg.criteria, stretchTargets.stretchPF, stretchTargets.stretchAvgR, analysis.walkForward, analysis.rollingWalkForward);
      if (!baselinePassesCriteria) {
        if (meetsStretch) {
          log(`${c.b}${c.grn}🏆 ALL CRITERIA + STRETCH TARGETS PASSED at iter ${iter}!${c.r}`);
          emitEvent({
            artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
            stage: "CRITERIA_PASSED", status: "success",
            pnl: iterPnl, message: "All criteria + stretch targets passed",
          });
          actor.send({ type: "CHECKPOINT_SAVED", bestScore: scoreResult.weighted, bestPnl: iterPnl, bestIter: iter });
          actor.send({ type: "CRITERIA_MET" });
          state.bestScore = scoreResult.weighted;
          state.bestPnl = iterPnl;
          state.bestIter = iter;
          bestScoreBreakdown = scoreResult.raw;
          if (scoreResult.weighted > globalBestScore) {
            globalBestScore = scoreResult.weighted;
            globalBestPnl = iterPnl;
            globalBestIter = iter;
            globalBestVariantId = variantMgr.getActive()?.id ?? globalBestVariantId;
          }
          checkpoint.save(cfg.checkpointDir, strategyContent, metrics, iter, paramOverrides, engineTrades, paramCount, lastStrategyParams, analysis ?? undefined);
          // Enrich last metric before break (normally done at loop bottom)
          const lastMetric = state.sessionMetrics[state.sessionMetrics.length - 1];
          if (lastMetric) {
            lastMetric.durationMs = Date.now() - iterStartMs;
            if (optSummary) lastMetric.summary = optSummary;
          }
          variantMgr.markComplete(scoreResult.weighted, iterPnl, iter, iter);
          variantMgr.save();
          break;
        }
        logOk(`✓ KB criteria met — continuing to reach stretch PF>=${stretchTargets.stretchPF} (current=${(metrics.profitFactor ?? 0).toFixed(2)})`);
      } else {
        // Baseline already passed — check stretch for early stop
        if (meetsStretch) {
          log(`${c.b}${c.grn}🏆 STRETCH TARGETS REACHED at iter ${iter}!${c.r}`);
          emitEvent({
            artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
            stage: "CRITERIA_PASSED", status: "success",
            pnl: iterPnl, message: "Stretch targets reached",
          });
          actor.send({ type: "CHECKPOINT_SAVED", bestScore: scoreResult.weighted, bestPnl: iterPnl, bestIter: iter });
          actor.send({ type: "CRITERIA_MET" });
          state.bestScore = scoreResult.weighted;
          state.bestPnl = iterPnl;
          state.bestIter = iter;
          bestScoreBreakdown = scoreResult.raw;
          if (scoreResult.weighted > globalBestScore) {
            globalBestScore = scoreResult.weighted;
            globalBestPnl = iterPnl;
            globalBestIter = iter;
            globalBestVariantId = variantMgr.getActive()?.id ?? globalBestVariantId;
          }
          checkpoint.save(cfg.checkpointDir, strategyContent, metrics, iter, paramOverrides, engineTrades, paramCount, lastStrategyParams, analysis ?? undefined);
          const lastMetric2 = state.sessionMetrics[state.sessionMetrics.length - 1];
          if (lastMetric2) {
            lastMetric2.durationMs = Date.now() - iterStartMs;
            if (optSummary) lastMetric2.summary = optSummary;
          }
          variantMgr.markComplete(scoreResult.weighted, iterPnl, iter, iter);
          variantMgr.save();
          break;
        }
        logOk(`✓ Criteria passing, stretch PF>=${stretchTargets.stretchPF} not yet reached (current=${(metrics.profitFactor ?? 0).toFixed(2)})`);
      }
    }

    // ---- Step 7b: Early kill check (progressive, derived from MODULE_CRITERIA) ----
    const variantIters = variantMgr.getActive()?.iterationsUsed ?? 0;
    const killReason = phaseHelpers.shouldKillVariant(bestPFEver, variantIters, moduleContext.moduleId, bestAvgREver);
    if (killReason) {
      logWarn(`⛔ Early kill: ${killReason}`);
      variantMgr.markKilled(killReason, state.bestScore, state.bestPnl, state.bestIter, variantIters);
      variantMgr.save();

      let switchResult: SwitchResult | null = null;

      const nextActiveKill = variantMgr.findNextActive();
      if (nextActiveKill) {
        log(`${c.blu}${c.b}Early kill — reactivating queued variant: ${nextActiveKill.id} (${cfg.maxIter - iter} iterations remaining)...${c.r}`);
        switchResult = await switchToExistingVariant({
          cfg, variantManager: variantMgr, variant: nextActiveKill,
          candles, effectiveWarmupBars, scoringWeights: cfg.scoring.weights,
        });
        if (switchResult) {
          logOk(`Reactivated variant: ${c.b}${nextActiveKill.id}${c.r} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`);
        } else {
          logWarn(`Failed to reactivate ${nextActiveKill.id} — falling back to generation`);
        }
      }

      if (!switchResult) {
        log(`${c.blu}${c.b}Generating new variant after early kill (${cfg.maxIter - iter} iterations remaining)...${c.r}`);
        for (let attempt = 0; attempt < 2; attempt++) {
          switchResult = await switchToNewVariant({
            cfg,
            moduleContext,
            variantManager: variantMgr,
            kbPath,
            seedStrategyFile,
            cancelSignal: shutdownController.signal,
            currentMetrics,
            currentAnalysis,
            lastStrategyParams,
            paramOverrides,
            currentScore: state.bestScore,
            bestScore: state.bestScore,
            globalIter: state.globalIter,
            candles,
            effectiveWarmupBars,
            scoringWeights: cfg.scoring.weights,
          });
          if (switchResult) break;
          logWarn(`Variant generation attempt ${attempt + 1} failed — ${attempt === 0 ? "retrying..." : "giving up."}`);
        }
      }
      if (!switchResult) {
        logWarn("Catalog may be exhausted — exiting loop.");
        break;
      }

      factory = switchResult.factory;
      esmCacheStale = false;
      checkpointRestored = false;
      paramOverrides = switchResult.paramOverrides;
      lastStrategyParams = switchResult.lastStrategyParams;
      paramCount = switchResult.paramCount;
      currentMetrics = switchResult.metrics;
      currentAnalysis = switchResult.analysis;
      lastAnalysis = switchResult.analysis;
      currentPnl = switchResult.pnl;
      bestScoreBreakdown = switchResult.scoreResult.raw;
      currentScoreResult = switchResult.scoreResult;
      logOk(`New variant: ${c.b}${switchResult.variant.id}${c.r} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`);

      success = false;
      lastRollbackReason = undefined;
      failedRestructures = [];
      lastContentHash = undefined;
      pendingVerdictOverride = undefined;
      lastActualBacktestMetrics = undefined;
      bestPFEver = currentMetrics.profitFactor ?? 0;
      bestAvgREver = currentMetrics.avgR ?? 0;
      bestVariantMetrics = {
        profitFactor: currentMetrics.profitFactor ?? 0,
        numTrades: currentMetrics.numTrades ?? 0,
        maxDrawdownPct: currentMetrics.maxDrawdownPct ?? 100,
        avgR: currentMetrics.avgR ?? 0,
        winRate: currentMetrics.winRate ?? 0,
      };
      seenParamFingerprints = new Set<string>();
      recentRejects = [];
      lastValidationWarnings = [];

      state.bestScore = switchResult.scoreResult.weighted;
      state.bestPnl = switchResult.pnl;
      state.bestIter = 0;
      state.previousPnl = switchResult.pnl;
      state.currentScore = switchResult.scoreResult.weighted;
      if (switchResult.scoreResult.weighted > globalBestScore) {
        globalBestScore = switchResult.scoreResult.weighted;
        globalBestPnl = switchResult.pnl;
        globalBestIter = iter;
        globalBestVariantId = switchResult.variant.id;
      }

      actor.stop();
      actor = createActor(breakerMachine, {
        input: {
          initialPhase: "refine",
          maxCycles: cfg.phases.maxCycles,
          bestScore: switchResult.scoreResult.weighted,
          bestPnl: switchResult.pnl,
          bestIter: 0,
        },
      });
      actor.start();

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "VARIANT_SWITCH", status: "info",
        message: `Early kill → variant ${switchResult.variant.id} (baseline score=${switchResult.scoreResult.weighted.toFixed(1)})`,
        phase: effectivePhase,
        claudeDurationMs: promptMetrics.claudeDurationMs,
        maxTurnsUsed: promptMetrics.maxTurns,
        actualTurnsUsed: promptMetrics.actualTurns,
      });
      state.sessionMetrics.push({
        iter,
        variantId: switchResult.variant.id,
        pnl: switchResult.pnl,
        pf: switchResult.metrics.profitFactor ?? 0,
        dd: switchResult.metrics.maxDrawdownPct ?? 0,
        wr: switchResult.metrics.winRate ?? 0,
        trades: switchResult.metrics.numTrades ?? 0,
        avgR: switchResult.metrics.avgR ?? 0,
        verdict: "baseline",
      });
      continue;
    }

    // ---- Step 8: Checkpoint / Rollback (score-based) ----
    // effectiveVerdict may have been overridden to "reject" by guardrails
    // (walk-forward overfit gate, free variable count gate).
    // Never promote an iteration that was guardrail-rejected, even if score improved.
    const bestScore = actor.getSnapshot().context.bestScore;
    if (scoreResult.weighted > bestScore && meetsMinTrades && effectiveVerdict !== "reject") {
      const phaseBeforeCheckpoint = actor.getSnapshot().value as string;
      actor.send({ type: "CHECKPOINT_SAVED", bestScore: scoreResult.weighted, bestPnl: iterPnl, bestIter: iter });
      const phaseAfterCheckpoint = actor.getSnapshot().value as string;
      state.bestScore = scoreResult.weighted;
      state.bestPnl = iterPnl;
      state.bestIter = iter;
      bestScoreBreakdown = scoreResult.raw;
      if (scoreResult.weighted > globalBestScore) {
        globalBestScore = scoreResult.weighted;
        globalBestPnl = iterPnl;
        globalBestIter = iter;
        globalBestVariantId = variantMgr.getActive()?.id ?? globalBestVariantId;
      }
      checkpoint.save(cfg.checkpointDir, strategyContent, metrics, iter, paramOverrides, engineTrades, paramCount, lastStrategyParams, analysis ?? undefined);
      lastRollbackReason = undefined; // Clear on successful checkpoint
      bestVariantMetrics = {
        profitFactor: metrics.profitFactor ?? 0,
        numTrades: metrics.numTrades ?? 0,
        maxDrawdownPct: metrics.maxDrawdownPct ?? 100,
        avgR: metrics.avgR ?? 0,
        winRate: metrics.winRate ?? 0,
      };
      const edgeInfo = metrics.edgeBpsNet != null ? ` Edge(net)=${metrics.edgeBpsNet.toFixed(0)}bps` : "";
      const tpdInfo = metrics.tradesPerDay != null ? ` T/day=${metrics.tradesPerDay.toFixed(2)}` : "";
      logOk(`💾 Checkpoint saved: iter=${iter} score=${scoreResult.weighted.toFixed(1)} PnL=$${iterPnl.toFixed(2)} trades=${metrics.numTrades} PF=${metrics.profitFactor?.toFixed(2)}${edgeInfo}${tpdInfo}`);
      log(`${c.b}${c.grn}⭐ New best: Score=${scoreResult.weighted.toFixed(1)} PnL=$${iterPnl.toFixed(2)} at iter ${iter}${c.r}`);

      // Detect restructure→refine transition: reload factory so refine sees new params
      if (phaseBeforeCheckpoint === "restructure" && phaseAfterCheckpoint === "refine") {
        const distPath = cfg.strategyFile.replace(/\/src\//, "/dist/").replace(/\.ts$/, ".js");
        const freshMod = await import(`${distPath}?t=${Date.now()}`) as Record<string, unknown>;
        const freshKey = Object.keys(freshMod).find(k => typeof freshMod[k] === "function" && k.startsWith("create"));
        if (freshKey) {
          factory = freshMod[freshKey] as StrategyFactory;
          esmCacheStale = false;
          lastStrategyParams = factory(paramOverrides).params;
          paramCount = countOptimizableParams(lastStrategyParams);
          logDim(`Restructure checkpoint → refine: factory reloaded (${freshKey}), ${paramCount} params`);
        } else {
          esmCacheStale = true;
          logWarn(`Restructure checkpoint → refine: factory reload failed, falling back to child-process`);
        }
      }
    } else if (scoreResult.weighted > bestScore && !meetsMinTrades) {
      logWarn(`⚠ Score ${scoreResult.weighted.toFixed(1)} is best but trades=${metrics.numTrades} < minTrades=${cfg.criteria.minTrades} — not saving checkpoint`);
      // B2: In restructure/research phase, rollback to prevent compounding degradation
      // from a filtered strategy that trades too little.
      if (phase !== "refine") {
        const bestParams = checkpoint.loadParams(cfg.checkpointDir);
        const restored = checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
        if (restored) {
          logWarn(`B2: Rolled back restructure with insufficient trades to checkpoint (iter ${state.bestIter})`);
          actor.send({ type: "SET_NEEDS_REBUILD", value: true });
          const restoredSource = fs.readFileSync(cfg.strategyFile, "utf8");
          lastContentHash = integrity.computeHash(restoredSource);
          const cpData = checkpoint.load(cfg.checkpointDir);
          const b2State = applyB2Rollback(
            { lastStrategyParams, paramOverrides, paramCount, currentMetrics, currentPnl, currentAnalysis, lastAnalysis, lastRollbackReason, failedRestructures },
            cpData, bestParams,
          );
          ({ lastStrategyParams, paramOverrides, paramCount, currentMetrics, currentPnl, currentAnalysis, lastAnalysis, lastRollbackReason, failedRestructures } = b2State);
        }
      }
    } else {
      // No checkpoint saved — rollback to prevent param drift.
      // Covers both explicit "reject" and "neutral" (score in noise band but not improved).
      const isNeutralDrift = effectiveVerdict !== "reject";
      logWarn(`↩ Rolling back: ${isNeutralDrift ? "score in noise band" : effectiveVerdict === scoreVerdict ? "score degraded" : "guardrail rejected"} (score=${scoreResult.weighted.toFixed(1)} vs best=${bestScore.toFixed(1)})`);

      // Side-effects: restore strategy source + params from checkpoint
      const bestParams = checkpoint.loadParams(cfg.checkpointDir);
      const restored = checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
      if (!restored) {
        logErr("Rollback failed — no checkpoint found.");
      } else {
        logDim(`Rollback OK: restored strategy from checkpoint (iter ${state.bestIter})`);
        if (phase !== "refine") {
          actor.send({ type: "SET_NEEDS_REBUILD", value: true });
        }
        const restoredSource = fs.readFileSync(cfg.strategyFile, "utf8");
        lastContentHash = integrity.computeHash(restoredSource);
      }

      // Pure state update: restore metrics, build reason, track failures
      const cpData = checkpoint.load(cfg.checkpointDir);
      const prevFailedCount = failedRestructures.length;
      const rollbackState = applyRollback(
        { lastStrategyParams, paramOverrides, paramCount, currentMetrics, currentPnl, currentAnalysis, lastAnalysis, lastRollbackReason, failedRestructures },
        cpData, bestParams,
        {
          iter, phase, scoreWeighted: scoreResult.weighted, bestScore,
          effectiveVerdict, scoreVerdict, metrics, paramCount, analysis,
          wfViolations, fvViolations, maxFreeVariables: cfg.criteria.maxFreeVariables,
          globalIter: state.globalIter, minTrades: cfg.criteria.minTrades ?? 50,
          minPF: cfg.criteria.minPF ?? 1.3, maxDD: cfg.criteria.maxDD ?? 10,
          minWR: cfg.criteria.minWR,
        },
      );
      ({ lastStrategyParams, paramOverrides, paramCount, currentMetrics, currentPnl, currentAnalysis, lastAnalysis, lastRollbackReason, failedRestructures } = rollbackState);

      if (cpData?.metrics) {
        logDim(`Using checkpoint metrics after rollback: PnL=$${currentPnl.toFixed(2)} Trades=${currentMetrics.numTrades}`);
      }
      if (failedRestructures.length > prevFailedCount) {
        const last = failedRestructures[failedRestructures.length - 1];
        logDim(`Tracked failed restructure: globalIter=${last.globalIter} trades=${metrics.numTrades} PF=${metrics.profitFactor?.toFixed(2)} score=${scoreResult.weighted.toFixed(1)} | ${last.diagnosis}`);
      }

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "ROLLBACK", status: "warn", pnl: currentPnl,
        message: `Rolled back to best (iter ${state.bestIter}, score=${bestScore.toFixed(1)})`,
        phase: effectivePhase,
        claudeDurationMs: promptMetrics.claudeDurationMs,
        maxTurnsUsed: promptMetrics.maxTurns,
        actualTurnsUsed: promptMetrics.actualTurns,
        verdict: effectiveVerdict,
      });
    }

    state.previousPnl = currentPnl;

    // ---- Step 9: Param-writer (deterministic) ----
    const metadataPath = path.join(cfg.artifactsDir, `iter${state.globalIter}-metadata.json`);
    let metadata: IterationMetadata | null = null;
    try {
      if (fs.existsSync(metadataPath)) {
        metadata = safeJsonParse<IterationMetadata>(fs.readFileSync(metadataPath, "utf8"), { repair: true });
      } else {
        // 1f: Log when metadata file not found
        logDim(`Metadata file not found: ${path.basename(metadataPath)}`);
      }
    } catch (err) {
      logWarn(`Could not read metadata JSON from Claude: ${(err as Error).message.split("\n")[0]}`);
    }

    if (metadata) {
      try {
        paramWriter.updateHistory({
          historyPath: cfg.paramHistoryFile,
          metadata,
          globalIter: state.globalIter,
          currentMetrics: preOptimizeMetrics,
          score: scoreResult.weighted,
          phase,
        });
        logDim("Parameter history updated deterministically");

        // Record tested combination for catalog-driven restructure tracking
        if (phase === "restructure" || phase === "research") {
          const rawComponents = metadata.selectedComponents;
          if (rawComponents && typeof rawComponents === "object") {
            const selectedComponents = validateSlugComponents(rawComponents, moduleContext.catalog);
            paramWriter.recordTestedCombination({
              historyPath: cfg.paramHistoryFile,
              globalIter: state.globalIter,
              components: selectedComponents,
              metrics: {
                pnl: iterPnl,
                pf: metrics.profitFactor ?? 0,
                wr: metrics.winRate ?? 0,
                dd: metrics.maxDrawdownPct ?? 0,
                trades: metrics.numTrades ?? 0,
              },
            });
            logDim("Tested combination recorded in parameter history");
          }
        }
      } catch (err) {
        logDim(`Param-writer error (non-blocking): ${(err as Error).message}`);
      }
    }

    // ---- Step 10: Auto-commit (optional) ----
    if (cfg.autoCommit) {
      try {
        execaSync("git", ["add", cfg.strategyFile], { cwd: cfg.repoRoot, timeout: 10000 });
        execaSync("git", ["commit", "-m", `iter${iter}: optimize ${cfg.asset}/${cfg.strategy} (${phase})`], { cwd: cfg.repoRoot, timeout: 10000 });
      } catch (err) {
        // 1f: Log git commit errors instead of silencing
        logDim(`Git auto-commit skipped: ${(err as Error).message.split("\n")[0]}`);
      }
    }

    // Enrich last metric with iteration duration and optimizer summary
    const lastMetricEntry = state.sessionMetrics[state.sessionMetrics.length - 1];
    if (lastMetricEntry) {
      lastMetricEntry.durationMs = Date.now() - iterStartMs;
      if (optSummary) lastMetricEntry.summary = optSummary;
    }

    variantMgr.incrementIterations();

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "ANALYSIS_DONE", status: "success", pnl: currentPnl,
      message: `Optimized (${effectivePhase}). Score=${scoreResult.weighted.toFixed(1)}.`,
      model: optimizeModel,
      durationMs: Date.now() - optimizeStartMs,
      phase: effectivePhase,
      claudeDurationMs: promptMetrics.claudeDurationMs,
      maxTurnsUsed: promptMetrics.maxTurns,
      actualTurnsUsed: promptMetrics.actualTurns,
      verdict: effectiveVerdict,
    });
  }

  // ---- Restore checkpoint to working file (baseline or best) ----
  const restored = checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
  if (restored) {
    logDim(`Restored checkpoint (iter ${state.bestIter}) to working file`);
  }
  const restoredParams = checkpoint.loadParams(cfg.checkpointDir);
  if (restoredParams) {
    paramOverrides = restoredParams;
  }

  // ---- Save variant registry ----
  // Update active variant's best scores and save
  const endVariant = variantMgr.getActive();
  if (endVariant) {
    variantMgr.updateBest(state.bestScore, state.bestPnl, state.bestIter);
  }
  variantMgr.save();
  const allVariants = variantMgr.getAll();
  if (allVariants.length > 1) {
    logDim(`Variant scores: ${allVariants.map(v => `${v.id}=${v.bestScore.toFixed(1)} (${v.status})`).join(", ")}`);
  }

  // ---- Session Summary ----
  const durationMs = Date.now() - startTime;
  const variantSummaries: VariantSummaryInfo[] = allVariants.map(v => ({
    id: v.id,
    status: v.status,
    bestScore: v.bestScore,
    bestPnl: v.bestPnl,
    iterationsUsed: v.iterationsUsed,
    killReason: v.killReason,
    plateauReason: v.plateauReason,
  }));
  const summaryOpts = {
    asset: cfg.asset,
    strategy: cfg.strategy,
    runId: cfg.runId,
    metrics: state.sessionMetrics,
    variants: variantSummaries,
    durationMs,
    totalIters: state.iter,
    globalBestVariantId,
    globalBestScore,
    globalBestPnl,
    globalBestIter,
    success,
  };
  const summary = buildSessionSummary(summaryOpts);

  emitEvent({
    artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset,
    iter: state.iter,
    stage: "LOOP_END",
    status: success ? "success" : "warn",
    pnl: globalBestPnl,
    message: success ? "Criteria passed" : `Max iter reached (phase=${state.currentPhase}, bestScore=${globalBestScore.toFixed(1)})`,
  });

  writeFileAtomic.sync(path.join(cfg.artifactsDir, "session-summary.txt"), summary, "utf8");

  const consoleSummary = buildConsoleSummary(summaryOpts);
  console.log(consoleSummary);

  // Send WhatsApp summary via @breaker/alerts
  // Pass credentials explicitly because dotenv.config() runs AFTER ESM imports resolve,
  // so @breaker/alerts env defaults would be stale (empty) without explicit overrides.
  try {
    await sendWhatsAppWithRetry(summary, recipient, {
      apiUrl: evoUrl,
      apiKey: evoKey,
      instance: process.env.EVOLUTION_INSTANCE,
    });
    logOk("WhatsApp summary sent");
  } catch (err) {
    const e = err as Record<string, unknown>;
    const msg = e.message || e.code || e.response?.toString?.() || JSON.stringify(err);
    logWarn(`WhatsApp send failed: ${msg}`);
  }

  // Stop the actor and clean up
  actor.stop();
  closeLoggers();
  teardownStdin();

  process.exit(success ? 0 : 1);
}

// Only run when executed directly
if (isMainModule(import.meta.url)) {
  orchestrate().catch((err) => {
    console.error("Orchestrator error:", err);
    process.exit(1);
  });
}
