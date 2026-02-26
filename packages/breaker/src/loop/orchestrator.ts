#!/usr/bin/env node
/**
 * orchestrator.ts — B.R.E.A.K.E.R. Orchestrator
 *
 * TypeScript strategy optimization loop backed by @trading/backtest engine.
 * Runs in-process backtests (~2s) for refine phase, child-process (~5s) for restructure.
 *
 * Usage: node dist/loop/orchestrator.js --asset=BTC [--max-iter=10] [--phase=refine]
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cac } from "cac";
import { sendWithRetry as sendWhatsAppWithRetry } from "@trading/whatsapp-gateway";
import { loadConfig, resolveAssetCriteria, resolveDataConfig, resolveDateRange } from "../lib/config.js";
import { buildStrategyDir, getStrategySourcePath } from "../lib/strategy-path.js";
import { getStrategyFactory } from "../lib/strategy-registry.js";
import { loadCandles } from "../lib/candle-loader.js";
import { acquireLock, releaseLock } from "../lib/lock.js";
import { classifyError, backoffDelay } from "./errors.js";
import { emitEvent } from "./stages/events.js";
import { saveCheckpoint, loadCheckpoint, loadCheckpointParams, rollback } from "./stages/checkpoint.js";
import { validateParamGuardrails } from "./stages/guardrails.js";
import { buildSessionSummary } from "./stages/summary.js";
import { runEngineInProcess, runEngineChild } from "./stages/run-engine.js";
import { optimizeStrategy, fixStrategy } from "./stages/optimize.js";
import { computeContentHash } from "./stages/integrity.js";
import { computeScore, compareScores } from "./stages/scoring.js";
import { buildOptimizePrompt } from "../automation/build-optimize-prompt-ts.js";
import { buildFixPrompt } from "../automation/build-fix-prompt-ts.js";
import { updateParameterHistory, loadParameterHistory, backfillLastIteration } from "./stages/param-writer.js";
import { conductResearch } from "./stages/research.js";
import type { Candle, CandleInterval, DataSource, Strategy, StrategyParam } from "@trading/backtest";
import type { ScoreVerdict } from "./stages/scoring.js";
import type { IterationMetadata } from "./stages/param-writer.js";
import type { LoopConfig, IterationState, LoopPhase } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../..");

export function parseArgs(): Partial<LoopConfig> & { initialPhase?: LoopPhase } {
  const cli = cac("breaker");
  cli.option("--asset <asset>", "Asset to optimize (e.g. BTC, ETH)");
  cli.option("--strategy <name>", "Strategy name (e.g. breakout, mean-reversion)");
  cli.option("--max-iter <n>", "Maximum optimization iterations");
  cli.option("--repo-root <path>", "Repository root path");
  cli.option("--auto-commit", "Auto-commit strategy changes after each iteration");
  cli.option("--phase <phase>", "Starting phase (refine|research|restructure)");
  cli.help();

  const { options } = cli.parse(process.argv);

  return {
    asset: options.asset || process.env.ASSET,
    strategy: options.strategy || process.env.STRATEGY || "breakout",
    maxIter: parseInt(String(options.maxIter || process.env.MAX_ITER || "10")),
    repoRoot: options.repoRoot || process.env.REPO_ROOT || DEFAULT_REPO_ROOT,
    autoCommit: Boolean(options.autoCommit) || process.env.AUTO_COMMIT === "true",
    initialPhase: (options.phase as LoopPhase) || undefined,
  };
}

export function buildConfig(partial: Partial<LoopConfig>): LoopConfig {
  const repoRoot = partial.repoRoot || DEFAULT_REPO_ROOT;
  const asset = partial.asset || "BTC";
  const strategy = partial.strategy || "breakout";
  const configFile = path.join(repoRoot, "breaker-config.json");
  const config = loadConfig(configFile);
  const criteria = resolveAssetCriteria(config, asset, strategy);
  const dataConfig = resolveDataConfig(config, asset, strategy);
  const { startTime, endTime } = resolveDateRange(config, asset, strategy);
  const strategyDir = buildStrategyDir(repoRoot, asset, strategy);
  const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1_$2");

  return {
    asset,
    strategy,
    maxIter: partial.maxIter || 10,
    maxFixAttempts: parseInt(process.env.MAX_FIX_ATTEMPTS || "3"),
    maxTransientFailures: parseInt(process.env.MAX_TRANSIENT_FAILURES || "3"),
    maxNoChange: parseInt(process.env.MAX_NO_CHANGE || "2"),
    autoCommit: partial.autoCommit || false,
    criteria,
    modelRouting: config.modelRouting,
    guardrails: config.guardrails,
    phases: config.phases,
    scoring: config.scoring,
    research: config.research,
    coin: dataConfig.coin,
    dataSource: dataConfig.dataSource as DataSource,
    interval: dataConfig.interval as CandleInterval,
    strategyFactory: dataConfig.strategyFactory,
    startTime,
    endTime,
    dbPath: path.join(repoRoot, "candles.db"),
    repoRoot,
    strategyDir,
    strategyFile: "", // resolved in main() via getStrategySourcePath
    configFile,
    paramHistoryFile: path.join(strategyDir, "parameter-history.json"),
    checkpointDir: path.join(strategyDir, "checkpoints"),
    artifactsDir: path.join(repoRoot, "artifacts", runId),
    runId,
  };
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export function checkCriteria(
  metrics: { totalPnl: number | null; numTrades: number | null; profitFactor: number | null; maxDrawdownPct: number | null; winRate: number | null; avgR: number | null },
  criteria: LoopConfig["criteria"],
): boolean {
  const pnl = metrics.totalPnl ?? 0;
  const trades = metrics.numTrades ?? 0;
  const pf = metrics.profitFactor ?? 0;
  const dd = metrics.maxDrawdownPct ?? 100;
  const wr = metrics.winRate ?? 0;
  const avgR = metrics.avgR ?? 0;

  const minTrades = criteria.minTrades ?? 150;
  const minPF = criteria.minPF ?? 1.25;
  const maxDD = criteria.maxDD ?? 12;
  const minWR = criteria.minWR ?? 20;
  const minAvgR = criteria.minAvgR ?? 0.15;

  return (
    pnl > 0 &&
    trades >= minTrades &&
    pf >= minPF &&
    dd <= maxDD &&
    wr >= minWR &&
    avgR >= minAvgR
  );
}

/**
 * Determine if we should escalate from current phase.
 * refine → research: 3+ consecutive neutral or 2+ no-change
 * research → restructure: 2+ no-change
 * restructure → refine (next cycle): 2+ no-change
 */
export function shouldEscalatePhase(state: IterationState, _cfg: LoopConfig): boolean {
  if (state.currentPhase === "refine") {
    return state.neutralStreak >= 3 || state.noChangeCount >= 2;
  }
  if (state.currentPhase === "research" || state.currentPhase === "restructure") {
    return state.noChangeCount >= 2;
  }
  return false;
}

/**
 * Reset counters that should not carry over between phases.
 */
export function resetPhaseCounters(state: IterationState): void {
  state.fixAttempts = 0;
  state.transientFailures = 0;
  state.neutralStreak = 0;
  state.noChangeCount = 0;
}

/**
 * Compute effective maxIter for a phase.
 * Uses the larger of: config value OR proportional allocation of global maxIter.
 * Proportions: refine 40%, research 20%, restructure 40%.
 */
export function getPhaseMaxIter(phase: LoopPhase, cfg: LoopConfig): number {
  const proportions: Record<LoopPhase, number> = { refine: 0.4, research: 0.2, restructure: 0.4 };
  const proportional = Math.max(1, Math.round(cfg.maxIter * proportions[phase]));
  return Math.max(cfg.phases[phase].maxIter, proportional);
}

/**
 * Determine next phase when phaseIterCount exceeds the phase's maxIter.
 */
export function transitionPhaseOnMaxIter(
  currentPhase: LoopPhase,
  phaseCycles: number,
  maxCycles: number,
): { nextPhase: LoopPhase; shouldBreak: boolean; incrementCycles: boolean } {
  if (currentPhase === "refine") {
    return { nextPhase: "research", shouldBreak: false, incrementCycles: false };
  }
  if (currentPhase === "research") {
    return { nextPhase: "restructure", shouldBreak: false, incrementCycles: false };
  }
  // restructure
  if (phaseCycles + 1 < maxCycles) {
    return { nextPhase: "refine", shouldBreak: false, incrementCycles: true };
  }
  return { nextPhase: currentPhase, shouldBreak: true, incrementCycles: true };
}

/**
 * Downgrade "accept" verdict to "neutral" when trades are below minTrades.
 */
export function computeEffectiveVerdict(
  scoreVerdict: ScoreVerdict,
  meetsMinTrades: boolean,
): ScoreVerdict {
  if (scoreVerdict === "accept" && !meetsMinTrades) return "neutral";
  return scoreVerdict;
}

/**
 * Count optimizable params in a strategy.
 */
function countOptimizableParams(params: Record<string, StrategyParam>): number {
  return Object.values(params).filter((p) => p.optimizable).length;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const partial = parseArgs();

  if (!partial.asset) {
    console.error("Usage: node orchestrator.js --asset=BTC [--strategy=breakout] [--max-iter=10] [--phase=refine]");
    process.exit(1);
  }

  const cfg = buildConfig(partial);
  log(`B.R.E.A.K.E.R. starting: asset=${cfg.asset} strategy=${cfg.strategy} maxIter=${cfg.maxIter} runId=${cfg.runId}`);

  // Resolve strategy source file
  cfg.strategyFile = getStrategySourcePath(cfg.repoRoot, cfg.strategyFactory);

  // Resolve strategy factory and create initial strategy
  const factory = getStrategyFactory(cfg.strategyFactory);

  // Ensure strategy dir exists
  if (!fs.existsSync(cfg.strategyDir)) {
    fs.mkdirSync(cfg.strategyDir, { recursive: true });
    log(`Created strategy dir: ${cfg.strategyDir}`);
  }

  // Acquire lock — everything after this MUST be inside try/finally
  acquireLock(cfg.asset);
  log(`Lock acquired for ${cfg.asset}`);

  let success = false;

  try {
  // Load candles ONCE for the entire session
  log(`Syncing candles: ${cfg.coin}/${cfg.interval} from ${cfg.dataSource}...`);
  const candles: Candle[] = await loadCandles({
    coin: cfg.coin,
    source: cfg.dataSource,
    interval: cfg.interval,
    startTime: cfg.startTime,
    endTime: cfg.endTime,
    dbPath: cfg.dbPath,
  });
  log(`Candles loaded: ${candles.length} bars (${new Date(candles[0].t).toISOString()} → ${new Date(candles[candles.length - 1].t).toISOString()})`);

  // Determine initial phase from param history or CLI
  const existingHistory = loadParameterHistory(cfg.paramHistoryFile);
  const initialPhase: LoopPhase = (partial as { initialPhase?: LoopPhase }).initialPhase || existingHistory.currentPhase || "refine";

  // Load initial param overrides from checkpoint
  let paramOverrides: Record<string, number> = loadCheckpointParams(cfg.checkpointDir) ?? {};

  // Create initial strategy to get params
  const initialStrategy = factory(paramOverrides);
  const strategyParams = initialStrategy.params;
  const paramCount = countOptimizableParams(strategyParams);

  const state: IterationState = {
    iter: 0,
    globalIter: existingHistory.iterations.length,
    bestPnl: 0,
    bestIter: 0,
    fixAttempts: 0,
    transientFailures: 0,
    noChangeCount: 0,
    previousPnl: 0,
    sessionMetrics: [],
    currentPhase: initialPhase,
    currentScore: 0,
    bestScore: 0,
    neutralStreak: 0,
    phaseCycles: 0,
  };

  // Load existing checkpoint
  const existingCheckpoint = loadCheckpoint(cfg.checkpointDir);
  if (existingCheckpoint) {
    state.bestPnl = existingCheckpoint.metrics.totalPnl ?? 0;
    state.bestIter = existingCheckpoint.iter;
    const cpScore = computeScore(
      existingCheckpoint.metrics,
      paramCount,
      existingCheckpoint.metrics.numTrades ?? 0,
      cfg.scoring.weights,
    );
    state.bestScore = cpScore.weighted;
    log(`Loaded checkpoint: bestPnl=$${state.bestPnl.toFixed(2)} score=${state.bestScore.toFixed(1)} from iter ${state.bestIter}`);
  }

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
    message: `strategy=${cfg.strategy} maxIter=${cfg.maxIter} bestPnl=${state.bestPnl} phase=${state.currentPhase}`,
  });

  let researchBriefPath: string | undefined;
  let phaseIterCount = 0;
  let lastContentHash: string | undefined;
  let needsRebuild = false;

  for (let iter = 1; iter <= cfg.maxIter; iter++) {
    state.iter = iter;
    state.globalIter++;
    phaseIterCount++;
    log(`=== Iteration ${iter}/${cfg.maxIter} (phase: ${state.currentPhase}, phaseIter: ${phaseIterCount}) ===`);

    // ---- Phase escalation check ----
    if (shouldEscalatePhase(state, cfg)) {
      if (state.currentPhase === "refine" && state.phaseCycles < cfg.phases.maxCycles) {
        log(`Escalating: refine → research (neutralStreak=${state.neutralStreak}, noChange=${state.noChangeCount})`);
        state.currentPhase = "research";
        phaseIterCount = 0;
        resetPhaseCounters(state);
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "PHASE_CHANGE", status: "info", message: "refine → research",
        });
      } else if (state.currentPhase === "research") {
        log(`Escalating: research → restructure (noChange=${state.noChangeCount})`);
        state.currentPhase = "restructure";
        phaseIterCount = 0;
        resetPhaseCounters(state);
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "PHASE_CHANGE", status: "info", message: "research → restructure",
        });
      } else if (state.currentPhase === "restructure") {
        state.phaseCycles++;
        if (state.phaseCycles < cfg.phases.maxCycles) {
          log(`Escalating: restructure → refine (cycle ${state.phaseCycles}/${cfg.phases.maxCycles})`);
          state.currentPhase = "refine";
          phaseIterCount = 0;
          resetPhaseCounters(state);
          researchBriefPath = undefined;
          emitEvent({
            artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
            stage: "PHASE_CHANGE", status: "info", message: `restructure → refine (cycle ${state.phaseCycles})`,
          });
        } else {
          log(`Max phase cycles (${cfg.phases.maxCycles}) reached. Ending loop.`);
          break;
        }
      }
    }

    // Check phase iter limits
    const phaseMaxIter = getPhaseMaxIter(state.currentPhase, cfg);
    if (phaseIterCount > phaseMaxIter) {
      const transition = transitionPhaseOnMaxIter(state.currentPhase, state.phaseCycles, cfg.phases.maxCycles);
      if (transition.incrementCycles) state.phaseCycles++;
      if (transition.shouldBreak) {
        log(`Max phase cycles (${cfg.phases.maxCycles}) reached.`);
        break;
      }
      log(`${state.currentPhase} phase complete (${phaseMaxIter} iters). Transitioning to ${transition.nextPhase}.`);
      if (transition.nextPhase === "refine") researchBriefPath = undefined;
      state.currentPhase = transition.nextPhase;
      phaseIterCount = 1;
      resetPhaseCounters(state);
    }

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "ITER_START", status: "info",
      message: `phase=${state.currentPhase}`,
    });

    // ---- Research stage (if in research phase) ----
    if (state.currentPhase === "research" && cfg.research.enabled && !researchBriefPath) {
      log("Conducting research...");
      const exhaustedApproaches = (existingHistory.approaches ?? [])
        .filter((a) => a.verdict === "exhausted")
        .map((a) => a.name);

      const researchResult = await conductResearch({
        asset: cfg.asset,
        currentMetrics: {
          pnl: state.previousPnl,
          pf: state.sessionMetrics.length > 0 ? state.sessionMetrics[state.sessionMetrics.length - 1].pf : 0,
          wr: state.sessionMetrics.length > 0 ? state.sessionMetrics[state.sessionMetrics.length - 1].wr : 0,
          dd: state.sessionMetrics.length > 0 ? state.sessionMetrics[state.sessionMetrics.length - 1].dd : 0,
        },
        exhaustedApproaches,
        artifactsDir: cfg.artifactsDir,
        model: cfg.research.model,
        timeoutMs: cfg.research.timeoutMs,
        repoRoot: cfg.repoRoot,
        allowedDomains: cfg.research.allowedDomains,
      });

      if (researchResult.success) {
        researchBriefPath = path.join(cfg.artifactsDir, "research-brief.json");
        log(`Research complete: ${researchResult.data!.suggestedApproaches.length} approaches found`);
      } else {
        log(`Research failed (non-blocking): ${researchResult.error}`);
      }
    }

    // ---- Step 1: Run backtest ----
    const strategyContent = fs.readFileSync(cfg.strategyFile, "utf8");
    const contentHash = computeContentHash(strategyContent);

    // Rebuild if strategy source changed (restructure phase)
    if (needsRebuild) {
      log("Rebuilding @trading/backtest after restructure...");
      try {
        execSync("pnpm --filter @trading/backtest build", {
          cwd: cfg.repoRoot,
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        needsRebuild = false;
        log("Rebuild complete.");
      } catch (err) {
        const errMsg = (err as Error).message.slice(0, 300);
        log(`Build failed: ${errMsg}`);
        state.fixAttempts++;
        if (state.fixAttempts > cfg.maxFixAttempts) {
          log(`Max fix attempts (${cfg.maxFixAttempts}) exceeded. Aborting.`);
          break;
        }

        // Try to fix the compilation error
        const fixPrompt = buildFixPrompt({
          strategySourcePath: cfg.strategyFile,
          errors: [],
          buildOutput: errMsg,
        });
        await fixStrategy({
          prompt: fixPrompt,
          strategyFile: cfg.strategyFile,
          repoRoot: cfg.repoRoot,
          model: cfg.modelRouting.fix,
        });
        continue;
      }
    }

    let engineResult;
    try {
      if (state.currentPhase === "refine" || contentHash === lastContentHash) {
        // In-process: fast path (~2s)
        const strategy = factory(paramOverrides);
        log(`Running in-process backtest (params: ${JSON.stringify(paramOverrides)})...`);
        engineResult = runEngineInProcess({
          candles,
          strategy,
          sourceInterval: cfg.interval,
        });
      } else {
        // Child process: needed after restructure edits (~5s)
        log("Running child-process backtest (post-restructure)...");
        engineResult = runEngineChild({
          repoRoot: cfg.repoRoot,
          factoryName: cfg.strategyFactory,
          paramOverrides,
          dbPath: cfg.dbPath,
          coin: cfg.coin,
          source: cfg.dataSource,
          interval: cfg.interval,
          startTime: cfg.startTime,
          endTime: cfg.endTime,
        });
      }
    } catch (err) {
      const errClass = classifyError((err as Error).message || "");
      log(`Backtest failed: ${errClass} — ${(err as Error).message.slice(0, 200)}`);

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "BACKTEST_ERROR", status: "error",
        message: `${errClass}: ${(err as Error).message.slice(0, 100)}`,
      });

      if (errClass === "compile_error") {
        state.fixAttempts++;
        if (state.fixAttempts > cfg.maxFixAttempts) {
          log(`Max fix attempts (${cfg.maxFixAttempts}) exceeded. Aborting.`);
          break;
        }
        const fixPrompt = buildFixPrompt({
          strategySourcePath: cfg.strategyFile,
          errors: [],
          buildOutput: (err as Error).message,
        });
        log(`Attempting fix (${state.fixAttempts}/${cfg.maxFixAttempts})...`);
        await fixStrategy({
          prompt: fixPrompt,
          strategyFile: cfg.strategyFile,
          repoRoot: cfg.repoRoot,
          model: cfg.modelRouting.fix,
        });
        needsRebuild = true;
        continue;
      }

      if (errClass === "timeout" || errClass === "network" || errClass === "transient") {
        state.transientFailures++;
        if (state.transientFailures > cfg.maxTransientFailures) {
          log(`Max transient failures (${cfg.maxTransientFailures}) exceeded. Aborting.`);
          break;
        }
        const delay = backoffDelay(state.transientFailures);
        log(`Transient error (${state.transientFailures}/${cfg.maxTransientFailures}). Waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      log(`Unrecoverable error. Aborting.`);
      break;
    }

    state.transientFailures = 0;
    state.fixAttempts = 0;
    lastContentHash = contentHash;

    const { metrics, analysis, trades } = engineResult;
    const currentPnl = metrics.totalPnl ?? 0;
    log(`Backtest OK: PnL=$${currentPnl.toFixed(2)} Trades=${metrics.numTrades} PF=${metrics.profitFactor?.toFixed(2)} WR=${metrics.winRate?.toFixed(1)}%`);

    // ---- Step 2: Compute score ----
    const scoreResult = computeScore(
      metrics,
      paramCount,
      metrics.numTrades ?? 0,
      cfg.scoring.weights,
    );
    state.currentScore = scoreResult.weighted;
    log(`Score: ${scoreResult.weighted.toFixed(1)}/100 (${scoreResult.breakdown})`);

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "PARSE_DONE", status: "success",
      pnl: currentPnl, pf: metrics.profitFactor ?? 0,
      dd: metrics.maxDrawdownPct ?? 0, trades: metrics.numTrades ?? 0,
      message: `PnL=$${currentPnl.toFixed(2)} Score=${scoreResult.weighted.toFixed(1)}`,
    });

    // ---- Backfill previous iteration's result in parameter-history ----
    try {
      backfillLastIteration({
        historyPath: cfg.paramHistoryFile,
        currentMetrics: {
          pnl: currentPnl,
          trades: metrics.numTrades ?? 0,
          pf: metrics.profitFactor ?? 0,
        },
      });
    } catch (err) {
      log(`Param-history backfill error (non-blocking): ${(err as Error).message}`);
    }

    // ---- Determine verdict using score ----
    const meetsMinTrades = (metrics.numTrades ?? 0) >= (cfg.criteria.minTrades ?? 0);
    const scoreVerdict = state.bestScore > 0
      ? compareScores(scoreResult.weighted, state.bestScore)
      : (scoreResult.weighted > 0 ? "accept" : "neutral");
    const effectiveVerdict = computeEffectiveVerdict(scoreVerdict, meetsMinTrades);

    let verdict: string;
    if (effectiveVerdict === "accept") {
      verdict = "improved";
      state.neutralStreak = 0;
    } else if (effectiveVerdict === "reject") {
      verdict = "degraded";
      state.neutralStreak = 0;
    } else {
      verdict = "neutral";
      state.neutralStreak++;
    }

    state.sessionMetrics.push({
      iter,
      pnl: currentPnl,
      pf: metrics.profitFactor ?? 0,
      dd: metrics.maxDrawdownPct ?? 0,
      wr: metrics.winRate ?? 0,
      trades: metrics.numTrades ?? 0,
      verdict,
    });

    // ---- Step 3: Criteria check ----
    if (checkCriteria(metrics, cfg.criteria)) {
      log(`ALL CRITERIA PASSED at iter ${iter}!`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "CRITERIA_PASSED", status: "success",
        pnl: currentPnl, message: "All criteria passed",
      });
      success = true;
      state.bestScore = scoreResult.weighted;
      state.bestPnl = currentPnl;
      state.bestIter = iter;
      saveCheckpoint(cfg.checkpointDir, strategyContent, metrics, iter, paramOverrides);
      break;
    }

    // ---- Step 4: Checkpoint / Rollback (score-based) ----
    if (scoreResult.weighted > state.bestScore && meetsMinTrades) {
      state.bestScore = scoreResult.weighted;
      state.bestPnl = currentPnl;
      state.bestIter = iter;
      saveCheckpoint(cfg.checkpointDir, strategyContent, metrics, iter, paramOverrides);
      log(`New best: Score=${scoreResult.weighted.toFixed(1)} PnL=$${currentPnl.toFixed(2)} at iter ${iter}`);
    } else if (scoreResult.weighted > state.bestScore && !meetsMinTrades) {
      log(`Score ${scoreResult.weighted.toFixed(1)} is best but trades=${metrics.numTrades} < minTrades=${cfg.criteria.minTrades} — not saving checkpoint`);
    } else if (scoreVerdict === "reject") {
      log(`Rolling back: Score ${scoreResult.weighted.toFixed(1)} dropped below threshold vs best ${state.bestScore.toFixed(1)}`);
      // Restore best params
      const bestParams = loadCheckpointParams(cfg.checkpointDir);
      if (bestParams) {
        paramOverrides = bestParams;
      }
      // Restore best strategy source
      const restored = rollback(cfg.checkpointDir, cfg.strategyFile);
      if (!restored) {
        log(`WARNING: Rollback failed — no checkpoint found.`);
      } else if (state.currentPhase !== "refine") {
        needsRebuild = true;
      }
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "ROLLBACK", status: "warn", pnl: currentPnl,
        message: `Rolled back to best (iter ${state.bestIter}, score=${state.bestScore.toFixed(1)})`,
      });
    }

    state.previousPnl = currentPnl;

    // ---- Step 5: Optimize (Claude suggests next changes) ----
    const isRestructure = state.currentPhase === "restructure" || !!researchBriefPath;
    const optimizeModel = isRestructure && cfg.modelRouting.restructure
      ? cfg.modelRouting.restructure
      : cfg.modelRouting.optimize;
    const optimizeTimeout = isRestructure ? 1800000 : 900000;
    const effectivePhase = researchBriefPath ? "restructure" : state.currentPhase;

    log(`Optimizing with ${optimizeModel} (phase=${effectivePhase}, timeout=${optimizeTimeout / 1000}s)...`);

    // Build prompt
    const currentStrategy = factory(paramOverrides);
    const prompt = buildOptimizePrompt({
      metrics,
      tradeAnalysis: analysis,
      strategySourcePath: cfg.strategyFile,
      strategyParams: currentStrategy.params,
      paramOverrides,
      criteria: cfg.criteria,
      asset: cfg.asset,
      strategy: cfg.strategy,
      phase: effectivePhase,
      iter,
      maxIter: cfg.maxIter,
      globalIter: state.globalIter,
      paramHistoryPath: cfg.paramHistoryFile,
      artifactsDir: cfg.artifactsDir,
      researchBriefPath,
    });

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "OPTIMIZE_START", status: "info",
      message: `phase=${effectivePhase}`,
    });

    const optResult = await optimizeStrategy({
      prompt,
      strategyFile: cfg.strategyFile,
      repoRoot: cfg.repoRoot,
      model: optimizeModel,
      phase: effectivePhase,
      artifactsDir: cfg.artifactsDir,
      globalIter: state.globalIter,
      timeoutMs: optimizeTimeout,
    });

    log("Optimization complete.");

    if (!optResult.success) {
      log(`Optimization failed: ${optResult.error?.slice(0, 200)}`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "OPTIMIZE_ERROR", status: "error",
        message: optResult.error?.slice(0, 100) || "unknown",
      });
      continue;
    }

    if (!optResult.data?.changed) {
      state.noChangeCount++;
      log(`No change (${state.noChangeCount}/${cfg.maxNoChange})`);
      if (state.noChangeCount >= cfg.maxNoChange) {
        log(`No-change limit reached — will escalate phase at next iteration.`);
      }
      continue;
    }
    state.noChangeCount = 0;

    // ---- Step 6: Apply changes & guardrails ----
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
        log(`Guardrail violations: ${violations.map((v) => `${v.field}: ${v.reason}`).join("; ")}`);
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "GUARDRAIL_VIOLATION", status: "warn",
          message: violations.map((v) => `${v.field}: ${v.reason}`).join("; "),
        });
        continue;
      }

      paramOverrides = newOverrides;
      log(`Params updated: ${JSON.stringify(optResult.data.paramOverrides)}`);
    } else {
      // Restructure: file was changed + passed typecheck in optimize step
      needsRebuild = true;
      log(`Strategy source modified (restructure). Will rebuild next iteration.`);
    }

    // ---- Step 7: Param-writer (deterministic) ----
    const metadataPath = path.join(cfg.artifactsDir, `iter${state.globalIter}-metadata.json`);
    let metadata: IterationMetadata | null = null;
    try {
      if (fs.existsSync(metadataPath)) {
        metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as IterationMetadata;
      }
    } catch {
      log("Could not read metadata JSON from Claude (non-blocking)");
    }

    if (metadata) {
      try {
        updateParameterHistory({
          historyPath: cfg.paramHistoryFile,
          metadata,
          globalIter: state.globalIter,
          currentMetrics: {
            pnl: currentPnl,
            trades: metrics.numTrades ?? 0,
            pf: metrics.profitFactor ?? 0,
          },
          score: scoreResult.weighted,
          phase: state.currentPhase,
        });
        log("Parameter history updated deterministically");
      } catch (err) {
        log(`Param-writer error (non-blocking): ${(err as Error).message}`);
      }
    }

    // ---- Step 8: Auto-commit (optional) ----
    if (cfg.autoCommit) {
      try {
        execSync(`git add "${cfg.strategyFile}" && git commit -m "iter${iter}: optimize ${cfg.asset}/${cfg.strategy} (${state.currentPhase})"`, {
          cwd: cfg.repoRoot,
          timeout: 10000,
        });
      } catch {
        // Non-critical
      }
    }

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "ANALYSIS_DONE", status: "success", pnl: currentPnl,
      message: `Optimized (${effectivePhase}). Score=${scoreResult.weighted.toFixed(1)}.`,
    });
  }

  // ---- Restore best checkpoint to working file ----
  if (state.bestIter > 0) {
    const restored = rollback(cfg.checkpointDir, cfg.strategyFile);
    if (restored) {
      log(`Restored best checkpoint (iter ${state.bestIter}) to working file`);
    }
    const bestParams = loadCheckpointParams(cfg.checkpointDir);
    if (bestParams) {
      paramOverrides = bestParams;
    }
  }

  // ---- Session Summary ----
  const durationMs = Date.now() - startTime;
  const summary = buildSessionSummary({
    asset: cfg.asset,
    strategy: cfg.strategy,
    runId: cfg.runId,
    metrics: state.sessionMetrics,
    durationMs,
    success,
    bestIter: state.bestIter,
    bestPnl: state.bestPnl,
  });

  emitEvent({
    artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset,
    iter: state.iter,
    stage: "LOOP_END",
    status: success ? "success" : "warn",
    pnl: state.bestPnl,
    message: success ? "Criteria passed" : `Max iter reached (phase=${state.currentPhase}, bestScore=${state.bestScore.toFixed(1)})`,
  });

  fs.writeFileSync(path.join(cfg.artifactsDir, "session-summary.txt"), summary, "utf8");
  log("Session summary:");
  console.log(summary);

  // Send WhatsApp summary via @trading/whatsapp-gateway
  const evoUrl = process.env.EVOLUTION_API_URL;
  const evoKey = process.env.EVOLUTION_API_KEY;
  const recipient = process.env.WHATSAPP_RECIPIENT;

  if (evoUrl && evoKey && recipient) {
    try {
      await sendWhatsAppWithRetry(summary);
      log("WhatsApp summary sent");
    } catch (err) {
      log(`WhatsApp send failed: ${(err as Error).message}`);
    }
  } else {
    log("WhatsApp not configured (missing EVOLUTION_API_URL, EVOLUTION_API_KEY, or WHATSAPP_RECIPIENT)");
  }

  } finally {
    releaseLock(cfg.asset);
    log(`Lock released for ${cfg.asset}`);
  }

  process.exit(success ? 0 : 1);
}

// Only run when executed directly
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("orchestrator.js");

if (isMain) {
  main().catch((err) => {
    console.error("Orchestrator error:", err);
    process.exit(1);
  });
}
