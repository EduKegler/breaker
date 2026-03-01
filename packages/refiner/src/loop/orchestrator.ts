#!/usr/bin/env node
/**
 * orchestrator.ts — B.R.E.A.K.E.R. Orchestrator
 *
 * TypeScript strategy optimization loop backed by @breaker/backtest engine.
 * Runs in-process backtests (~2s) for refine phase, child-process (~5s) for restructure.
 *
 * Usage: node dist/loop/orchestrator.js --asset=BTC [--max-iter=10] [--phase=refine]
 */

import fs from "node:fs";
import path from "node:path";
import { execaSync } from "execa";
import writeFileAtomic from "write-file-atomic";
import { createActor } from "xstate";

import { isMainModule, backoffDelay } from "@breaker/kit";
import { sendWhatsApp as sendWhatsAppWithRetry } from "@breaker/alerts";
import { getStrategySourcePath } from "../lib/get-strategy-source-path.js";
import { strategyRegistry } from "../lib/strategy-registry.js";
import { loadCandles } from "../lib/candle-loader.js";
import { lock } from "../lib/lock.js";
import { classifyError } from "./classify-error.js";
import { parseArgs } from "./parse-args.js";
import { buildLoopConfig } from "./build-loop-config.js";
import { checkCriteria } from "./check-criteria.js";
import { phaseHelpers } from "./phase-helpers.js";
import { emitEvent } from "./stages/events.js";
import { checkpoint } from "./stages/checkpoint.js";
import { validateParamGuardrails } from "./stages/guardrails.js";
import { buildSessionSummary } from "./stages/summary.js";
import { runEngineInProcess } from "./stages/run-engine-in-process.js";
import { runEngineChild } from "./stages/spawn-engine-child.js";
import { optimizeStrategy } from "./stages/optimize.js";
import { fixStrategy } from "./stages/fix-strategy.js";
import { integrity } from "./stages/integrity.js";
import { computeScore } from "./stages/scoring.js";
import { compareScores } from "./stages/compare-scores.js";
import { buildOptimizePrompt } from "../automation/build-optimize-prompt-ts.js";
import { buildFixPrompt } from "../automation/build-fix-prompt-ts.js";
import { paramWriter } from "./stages/param-writer.js";
import { conductResearch } from "./stages/research.js";
import { safeJsonParse } from "../lib/safe-json.js";
import { breakerMachine } from "./state-machine.js";
import type { Candle, CandleInterval, StrategyParam } from "@breaker/backtest";
import type { IterationMetadata } from "./stages/param-writer.js";
import type { IterationState, LoopPhase } from "./types.js";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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
  const startTime = Date.now();
  const partial = parseArgs();

  if (!partial.asset) {
    console.error("Usage: node orchestrator.js --asset=BTC [--strategy=breakout] [--max-iter=10] [--phase=refine]");
    process.exit(1);
  }

  const cfg = buildLoopConfig(partial);
  log(`B.R.E.A.K.E.R. starting: asset=${cfg.asset} strategy=${cfg.strategy} maxIter=${cfg.maxIter} runId=${cfg.runId}`);

  // Resolve strategy source file
  cfg.strategyFile = getStrategySourcePath(cfg.repoRoot, cfg.strategyFactory);

  // Resolve strategy factory and create initial strategy
  const factory = strategyRegistry.get(cfg.strategyFactory);

  // Ensure strategy dir exists
  if (!fs.existsSync(cfg.strategyDir)) {
    fs.mkdirSync(cfg.strategyDir, { recursive: true });
    log(`Created strategy dir: ${cfg.strategyDir}`);
  }

  // Acquire lock — everything after this MUST be inside try/finally
  lock.acquire(cfg.asset);
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
  log(`Candles loaded: ${candles.length} bars (${new Date(candles[0].t).toISOString()} -> ${new Date(candles[candles.length - 1].t).toISOString()})`);

  // Determine initial phase from param history or CLI
  const existingHistory = paramWriter.loadHistory(cfg.paramHistoryFile);
  const initialPhase: LoopPhase = (partial as { initialPhase?: LoopPhase }).initialPhase || existingHistory.currentPhase || "refine";

  // Load initial param overrides from checkpoint
  let paramOverrides: Record<string, number> = checkpoint.loadParams(cfg.checkpointDir) ?? {};

  // Create initial strategy to get params
  const initialStrategy = factory(paramOverrides);
  const strategyParams = initialStrategy.params;
  const paramCount = countOptimizableParams(strategyParams);

  // Load existing checkpoint to seed best scores
  let initialBestPnl = 0;
  let initialBestIter = 0;
  let initialBestScore = 0;
  const existingCheckpoint = checkpoint.load(cfg.checkpointDir);
  if (existingCheckpoint) {
    initialBestPnl = existingCheckpoint.metrics.totalPnl ?? 0;
    initialBestIter = existingCheckpoint.iter;
    const cpScore = computeScore(
      existingCheckpoint.metrics,
      paramCount,
      existingCheckpoint.metrics.numTrades ?? 0,
      cfg.scoring.weights,
    );
    initialBestScore = cpScore.weighted;
    log(`Loaded checkpoint: bestPnl=$${initialBestPnl.toFixed(2)} score=${initialBestScore.toFixed(1)} from iter ${initialBestIter}`);
  }

  // Create xstate actor for state management
  const actor = createActor(breakerMachine, {
    input: {
      initialPhase,
      maxCycles: cfg.phases.maxCycles,
      bestScore: initialBestScore,
      bestPnl: initialBestPnl,
      bestIter: initialBestIter,
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
    previousPnl: 0,
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

  for (let iter = 1; iter <= cfg.maxIter; iter++) {
    state.iter = iter;
    state.globalIter++;

    // Send ITER_START to the machine (increments phaseIterCount)
    actor.send({ type: "ITER_START" });
    const mCtx = actor.getSnapshot().context;
    const currentPhase = actor.getSnapshot().value as LoopPhase;
    log(`=== Iteration ${iter}/${cfg.maxIter} (phase: ${currentPhase}, phaseIter: ${mCtx.phaseIterCount}) ===`);

    // Sync IterationState from machine for backwards compat
    state.currentPhase = currentPhase;

    // ---- Phase escalation check ----
    const prevPhase = currentPhase;
    actor.send({ type: "ESCALATE" });
    let snap = actor.getSnapshot();
    const phaseAfterEscalation = snap.value as LoopPhase | "done";

    if (phaseAfterEscalation === "done") {
      log(`Max phase cycles (${cfg.phases.maxCycles}) reached. Ending loop.`);
      break;
    }

    if (phaseAfterEscalation !== prevPhase) {
      log(`Escalating: ${prevPhase} -> ${phaseAfterEscalation} (neutralStreak=${mCtx.neutralStreak}, noChange=${mCtx.noChangeCount})`);
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "PHASE_CHANGE", status: "info",
        message: `${prevPhase} -> ${phaseAfterEscalation}`,
      });
    }

    // Check phase iter limits
    const activePhase = snap.value as LoopPhase;
    const phaseMaxIter = phaseHelpers.getMaxIter(activePhase, cfg);
    if (snap.context.phaseIterCount > phaseMaxIter) {
      const prevPhase2 = activePhase;
      actor.send({ type: "PHASE_TIMEOUT" });
      snap = actor.getSnapshot();
      const phaseAfterTimeout = snap.value as LoopPhase | "done";

      if (phaseAfterTimeout === "done") {
        log(`Max phase cycles (${cfg.phases.maxCycles}) reached.`);
        break;
      }

      log(`${prevPhase2} phase complete (${phaseMaxIter} iters). Transitioning to ${phaseAfterTimeout}.`);
    }

    // Read fresh state from actor
    snap = actor.getSnapshot();
    const phase = snap.value as LoopPhase;
    state.currentPhase = phase;

    emitEvent({
      artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
      stage: "ITER_START", status: "info",
      message: `phase=${phase}`,
    });

    // ---- Research stage (if in research phase) ----
    const researchBriefPath = snap.context.researchBriefPath;
    if (phase === "research" && cfg.research.enabled && !researchBriefPath) {
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
        const briefPath = path.join(cfg.artifactsDir, "research-brief.json");
        actor.send({ type: "RESEARCH_DONE", briefPath });
        log(`Research complete: ${researchResult.data!.suggestedApproaches.length} approaches found`);
      } else {
        log(`Research failed (non-blocking): ${researchResult.error}`);
      }
    }

    // ---- Step 1: Run backtest ----
    const strategyContent = fs.readFileSync(cfg.strategyFile, "utf8");
    const contentHash = integrity.computeHash(strategyContent);

    // Rebuild if strategy source changed (restructure phase)
    const needsRebuild = actor.getSnapshot().context.needsRebuild;
    if (needsRebuild) {
      log("Rebuilding @breaker/backtest after restructure...");
      try {
        execaSync("pnpm", ["--filter", "@breaker/backtest", "build"], {
          cwd: cfg.repoRoot,
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        actor.send({ type: "SET_NEEDS_REBUILD", value: false });
        log("Rebuild complete.");
      } catch (err) {
        const errMsg = ((err as { stderr?: string }).stderr || (err as Error).message).slice(0, 300);
        log(`Build failed: ${errMsg}`);
        actor.send({ type: "COMPILE_ERROR" });
        if (actor.getSnapshot().context.fixAttempts > cfg.maxFixAttempts) {
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
      if (phase === "refine" || contentHash === lastContentHash) {
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
      log(`Backtest failed: ${errClass} -- ${(err as Error).message.slice(0, 200)}`);

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "BACKTEST_ERROR", status: "error",
        message: `${errClass}: ${(err as Error).message.slice(0, 100)}`,
      });

      if (errClass === "compile_error") {
        actor.send({ type: "COMPILE_ERROR" });
        const mCtxErr = actor.getSnapshot().context;
        if (mCtxErr.fixAttempts > cfg.maxFixAttempts) {
          log(`Max fix attempts (${cfg.maxFixAttempts}) exceeded. Aborting.`);
          break;
        }
        const fixPrompt = buildFixPrompt({
          strategySourcePath: cfg.strategyFile,
          errors: [],
          buildOutput: (err as Error).message,
        });
        log(`Attempting fix (${mCtxErr.fixAttempts}/${cfg.maxFixAttempts})...`);
        await fixStrategy({
          prompt: fixPrompt,
          strategyFile: cfg.strategyFile,
          repoRoot: cfg.repoRoot,
          model: cfg.modelRouting.fix,
        });
        continue;
      }

      if (errClass === "timeout" || errClass === "network" || errClass === "transient") {
        actor.send({ type: "TRANSIENT_ERROR" });
        const mCtxErr = actor.getSnapshot().context;
        if (mCtxErr.transientFailures > cfg.maxTransientFailures) {
          log(`Max transient failures (${cfg.maxTransientFailures}) exceeded. Aborting.`);
          break;
        }
        const delay = backoffDelay(mCtxErr.transientFailures);
        log(`Transient error (${mCtxErr.transientFailures}/${cfg.maxTransientFailures}). Waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      log(`Unrecoverable error. Aborting.`);
      break;
    }

    // Backtest succeeded — reset error counters via BACKTEST_OK
    const { metrics, analysis, trades } = engineResult;
    const currentPnl = metrics.totalPnl ?? 0;

    // Compute score
    const scoreResult = computeScore(
      metrics,
      paramCount,
      metrics.numTrades ?? 0,
      cfg.scoring.weights,
    );

    actor.send({ type: "BACKTEST_OK", currentScore: scoreResult.weighted, currentPnl });
    lastContentHash = contentHash;

    log(`Backtest OK: PnL=$${currentPnl.toFixed(2)} Trades=${metrics.numTrades} PF=${metrics.profitFactor?.toFixed(2)} WR=${metrics.winRate?.toFixed(1)}%`);
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
      paramWriter.backfillLastIteration({
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
    const machCtx = actor.getSnapshot().context;
    const meetsMinTrades = (metrics.numTrades ?? 0) >= (cfg.criteria.minTrades ?? 0);
    const scoreVerdict = machCtx.bestScore > 0
      ? compareScores(scoreResult.weighted, machCtx.bestScore)
      : (scoreResult.weighted > 0 ? "accept" : "neutral");
    const effectiveVerdict = phaseHelpers.computeEffectiveVerdict(scoreVerdict, meetsMinTrades);

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
      actor.send({ type: "CHECKPOINT_SAVED", bestScore: scoreResult.weighted, bestPnl: currentPnl, bestIter: iter });
      actor.send({ type: "CRITERIA_MET" });
      // Sync state for summary
      state.bestScore = scoreResult.weighted;
      state.bestPnl = currentPnl;
      state.bestIter = iter;
      checkpoint.save(cfg.checkpointDir, strategyContent, metrics, iter, paramOverrides);
      break;
    }

    // ---- Step 4: Checkpoint / Rollback (score-based) ----
    const bestScore = actor.getSnapshot().context.bestScore;
    if (scoreResult.weighted > bestScore && meetsMinTrades) {
      actor.send({ type: "CHECKPOINT_SAVED", bestScore: scoreResult.weighted, bestPnl: currentPnl, bestIter: iter });
      state.bestScore = scoreResult.weighted;
      state.bestPnl = currentPnl;
      state.bestIter = iter;
      checkpoint.save(cfg.checkpointDir, strategyContent, metrics, iter, paramOverrides);
      log(`New best: Score=${scoreResult.weighted.toFixed(1)} PnL=$${currentPnl.toFixed(2)} at iter ${iter}`);
    } else if (scoreResult.weighted > bestScore && !meetsMinTrades) {
      log(`Score ${scoreResult.weighted.toFixed(1)} is best but trades=${metrics.numTrades} < minTrades=${cfg.criteria.minTrades} -- not saving checkpoint`);
    } else if (scoreVerdict === "reject") {
      log(`Rolling back: Score ${scoreResult.weighted.toFixed(1)} dropped below threshold vs best ${bestScore.toFixed(1)}`);
      // Restore best params
      const bestParams = checkpoint.loadParams(cfg.checkpointDir);
      if (bestParams) {
        paramOverrides = bestParams;
      }
      // Restore best strategy source
      const restored = checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
      if (!restored) {
        log(`WARNING: Rollback failed -- no checkpoint found.`);
      } else if (phase !== "refine") {
        actor.send({ type: "SET_NEEDS_REBUILD", value: true });
      }
      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "ROLLBACK", status: "warn", pnl: currentPnl,
        message: `Rolled back to best (iter ${state.bestIter}, score=${bestScore.toFixed(1)})`,
      });
    }

    state.previousPnl = currentPnl;

    // ---- Step 5: Optimize (Claude suggests next changes) ----
    const currentResearchBriefPath = actor.getSnapshot().context.researchBriefPath;
    const isRestructure = phase === "restructure" || !!currentResearchBriefPath;
    const optimizeModel = isRestructure && cfg.modelRouting.restructure
      ? cfg.modelRouting.restructure
      : cfg.modelRouting.optimize;
    const optimizeTimeout = isRestructure ? 1800000 : 900000;
    const effectivePhase = currentResearchBriefPath ? "restructure" : phase;

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
      researchBriefPath: currentResearchBriefPath,
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
      actor.send({ type: "NO_CHANGE" });
      const noChangeCount = actor.getSnapshot().context.noChangeCount;
      log(`No change (${noChangeCount}/${cfg.maxNoChange})`);
      if (noChangeCount >= cfg.maxNoChange) {
        log(`No-change limit reached -- will escalate phase at next iteration.`);
      }
      continue;
    }
    actor.send({ type: "CHANGE_APPLIED", isRestructure: effectivePhase !== "refine" });

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
      // needsRebuild already set by CHANGE_APPLIED with isRestructure=true
      log(`Strategy source modified (restructure). Will rebuild next iteration.`);
    }

    // ---- Step 7: Param-writer (deterministic) ----
    const metadataPath = path.join(cfg.artifactsDir, `iter${state.globalIter}-metadata.json`);
    let metadata: IterationMetadata | null = null;
    try {
      if (fs.existsSync(metadataPath)) {
        metadata = safeJsonParse<IterationMetadata>(fs.readFileSync(metadataPath, "utf8"), { repair: true });
      }
    } catch {
      log("Could not read metadata JSON from Claude (non-blocking)");
    }

    if (metadata) {
      try {
        paramWriter.updateHistory({
          historyPath: cfg.paramHistoryFile,
          metadata,
          globalIter: state.globalIter,
          currentMetrics: {
            pnl: currentPnl,
            trades: metrics.numTrades ?? 0,
            pf: metrics.profitFactor ?? 0,
          },
          score: scoreResult.weighted,
          phase,
        });
        log("Parameter history updated deterministically");
      } catch (err) {
        log(`Param-writer error (non-blocking): ${(err as Error).message}`);
      }
    }

    // ---- Step 8: Auto-commit (optional) ----
    if (cfg.autoCommit) {
      try {
        execaSync("git", ["add", cfg.strategyFile], { cwd: cfg.repoRoot, timeout: 10000 });
        execaSync("git", ["commit", "-m", `iter${iter}: optimize ${cfg.asset}/${cfg.strategy} (${phase})`], { cwd: cfg.repoRoot, timeout: 10000 });
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
    const restored = checkpoint.rollback(cfg.checkpointDir, cfg.strategyFile);
    if (restored) {
      log(`Restored best checkpoint (iter ${state.bestIter}) to working file`);
    }
    const bestParams = checkpoint.loadParams(cfg.checkpointDir);
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

  writeFileAtomic.sync(path.join(cfg.artifactsDir, "session-summary.txt"), summary, "utf8");
  log("Session summary:");
  console.log(summary);

  // Send WhatsApp summary via @breaker/alerts
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

  // Stop the actor
  actor.stop();

  } finally {
    lock.release(cfg.asset);
    log(`Lock released for ${cfg.asset}`);
  }

  process.exit(success ? 0 : 1);
}

// Only run when executed directly
if (isMainModule(import.meta.url)) {
  orchestrate().catch((err) => {
    console.error("Orchestrator error:", err);
    process.exit(1);
  });
}
