#!/usr/bin/env node
/**
 * orchestrator.ts — B.R.E.A.K.E.R. Orchestrator
 *
 * TypeScript replacement for breaker-loop.sh.
 * Runs the autonomous Pine Script optimization loop with:
 * - Content integrity validation
 * - Multi-objective scoring
 * - Phase management (refine → research → restructure)
 * - Deterministic param-writer
 * - Research stage
 *
 * Usage: node dist/loop/orchestrator.js --asset=BTC [--max-iter=10] [--phase=refine]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveAssetCriteria, resolveChartUrl, resolveDateRange } from "../lib/config.js";
import { buildStrategyDir, findActiveStrategyFile } from "../lib/strategy-path.js";
import { countPineInputs } from "../automation/parse-results.js";
import { acquireLock, acquireLockBlocking, releaseLock } from "../lib/lock.js";
import { classifyError, backoffDelay } from "./errors.js";
import { emitEvent } from "./stages/events.js";
import { saveCheckpoint, loadCheckpoint, rollback } from "./stages/checkpoint.js";
import { validateGuardrails } from "./stages/guardrails.js";
import { buildSessionSummary } from "./stages/summary.js";
import { runBacktest } from "./stages/backtest.js";
import { parseResults } from "./stages/parse.js";
import { optimizeStrategy, fixStrategy } from "./stages/optimize.js";
import { computeContentToken, validateIntegrity } from "./stages/integrity.js";
import { computeScore, compareScores } from "./stages/scoring.js";
import type { ScoreVerdict } from "./stages/scoring.js";
import { updateParameterHistory, loadParameterHistory, backfillLastIteration } from "./stages/param-writer.js";
import { conductResearch } from "./stages/research.js";
import type { IterationMetadata } from "./stages/param-writer.js";
import type { LoopConfig, IterationState, IterationMetric, LoopPhase } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../..");

export function parseArgs(): Partial<LoopConfig> & { initialPhase?: LoopPhase } {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return {
    asset: args["asset"] || process.env.ASSET,
    strategy: args["strategy"] || process.env.STRATEGY || "breakout",
    maxIter: parseInt(args["max-iter"] || process.env.MAX_ITER || "10"),
    repoRoot: args["repo-root"] || process.env.REPO_ROOT || DEFAULT_REPO_ROOT,
    autoCommit: (args["auto-commit"] || process.env.AUTO_COMMIT || "false") === "true",
    initialPhase: (args["phase"] as LoopPhase) || undefined,
  };
}

export function buildConfig(partial: Partial<LoopConfig>): LoopConfig {
  const repoRoot = partial.repoRoot || DEFAULT_REPO_ROOT;
  const asset = partial.asset || "BTC";
  const strategy = partial.strategy || "breakout";
  const configFile = path.join(repoRoot, "breaker-config.json");
  const config = loadConfig(configFile);
  const criteria = resolveAssetCriteria(config, asset, strategy);
  const chartUrl = resolveChartUrl(config, asset, strategy);
  const dateRange = resolveDateRange(config, asset, strategy);
  const strategyDir = buildStrategyDir(repoRoot, asset, strategy);
  const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1_$2");

  return {
    asset,
    strategy,
    maxIter: partial.maxIter || 10,
    maxFixAttempts: parseInt(process.env.MAX_FIX_ATTEMPTS || "3"),
    maxStaleAttempts: parseInt(process.env.MAX_STALE_ATTEMPTS || "2"),
    maxTransientFailures: parseInt(process.env.MAX_TRANSIENT_FAILURES || "3"),
    maxNoChange: parseInt(process.env.MAX_NO_CHANGE || "2"),
    autoCommit: partial.autoCommit || false,
    criteria,
    modelRouting: config.modelRouting,
    guardrails: config.guardrails,
    phases: config.phases,
    scoring: config.scoring,
    research: config.research,
    chartUrl,
    dateRange,
    repoRoot,
    strategyDir,
    strategyFile: "", // resolved in main() via findActiveStrategyFile
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
 * research → restructure: 2+ no-change (stalled research)
 * restructure → refine (next cycle): 2+ no-change
 */
export function shouldEscalatePhase(state: IterationState, cfg: LoopConfig): boolean {
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
  state.staleAttempts = 0;
  state.integrityAttempts = 0;
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
 * Handles refine → research → restructure → refine cycle.
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
 * Prevents false progress signals that block phase escalation.
 */
export function computeEffectiveVerdict(
  scoreVerdict: ScoreVerdict,
  meetsMinTrades: boolean,
): ScoreVerdict {
  if (scoreVerdict === "accept" && !meetsMinTrades) return "neutral";
  return scoreVerdict;
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

  // Bootstrap: if strategy dir doesn't exist, create it and copy template
  if (!fs.existsSync(cfg.strategyDir)) {
    const templateFile = path.join(cfg.repoRoot, "strategy.pine");
    if (fs.existsSync(templateFile)) {
      fs.mkdirSync(cfg.strategyDir, { recursive: true });
      fs.copyFileSync(templateFile, path.join(cfg.strategyDir, `${cfg.strategy}.pine`));
      log(`Bootstrapped ${cfg.asset}/${cfg.strategy} from template`);
    } else {
      console.error(`Strategy directory not found and no template available: ${cfg.strategyDir}`);
      process.exit(1);
    }
  }

  // Resolve active strategy file
  cfg.strategyFile = findActiveStrategyFile(cfg.strategyDir);

  // Acquire lock — everything after this MUST be inside try/finally
  acquireLock(cfg.asset);
  log(`Lock acquired for ${cfg.asset}`);

  let success = false;

  try {
  // Determine initial phase from param history or CLI
  const existingHistory = loadParameterHistory(cfg.paramHistoryFile);
  const initialPhase: LoopPhase = (partial as any).initialPhase || existingHistory.currentPhase || "refine";

  const state: IterationState = {
    iter: 0,
    globalIter: existingHistory.iterations.length,
    bestPnl: 0,
    bestIter: 0,
    fixAttempts: 0,
    staleAttempts: 0,
    integrityAttempts: 0,
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
      existingCheckpoint.pineContent,
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
  let lastBacktestedToken: string | undefined;
  let lastResultJsonPath: string | undefined;

  {
    for (let iter = 1; iter <= cfg.maxIter; iter++) {
      state.iter = iter;
      state.globalIter++;
      phaseIterCount++;
      log(`=== Iteration ${iter}/${cfg.maxIter} (phase: ${state.currentPhase}, phaseIter: ${phaseIterCount}) ===`);

      // ---- Phase escalation check ----
      if (shouldEscalatePhase(state, cfg)) {
        const prevPhase = state.currentPhase;
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
            log(`Escalating: restructure → refine (cycle ${state.phaseCycles}/${cfg.phases.maxCycles}, noChange=${state.noChangeCount})`);
            state.currentPhase = "refine";
            phaseIterCount = 0;
            resetPhaseCounters(state);
            researchBriefPath = undefined; // Clear stale brief for new cycle

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
        if (transition.nextPhase === "refine") researchBriefPath = undefined; // Clear stale brief for new cycle
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

      // ---- Step 1: Compute content token & run backtest ----
      const pineContent = fs.readFileSync(cfg.strategyFile, "utf8");
      const contentToken = computeContentToken(pineContent);

      // Skip backtest if pine file is unchanged since last backtest (saves ~3-5 min)
      if (contentToken === lastBacktestedToken && lastResultJsonPath) {
        log(`Skipping backtest — pine unchanged (token=${contentToken}). Jumping to optimize.`);
        // Jump directly to optimize step with previous results
        const beforeContent = fs.readFileSync(cfg.strategyFile, "utf8");

        const isRestructure = state.currentPhase === "restructure" || !!researchBriefPath;
        const optimizeModel = isRestructure && cfg.modelRouting.restructure
          ? cfg.modelRouting.restructure
          : cfg.modelRouting.optimize;
        const optimizeTimeout = isRestructure ? 1800000 : 900000;
        log(`Optimizing with ${optimizeModel} (phase=${state.currentPhase}, timeout=${optimizeTimeout / 1000}s)...`);

        const optResult = await optimizeStrategy({
          repoRoot: cfg.repoRoot,
          resultJsonPath: lastResultJsonPath,
          iter,
          maxIter: cfg.maxIter,
          asset: cfg.asset,
          strategy: cfg.strategy,
          strategyFile: cfg.strategyFile,
          model: optimizeModel,
          phase: researchBriefPath ? "restructure" : state.currentPhase,
          researchBriefPath,
          artifactsDir: cfg.artifactsDir,
          globalIter: state.globalIter,
          timeoutMs: optimizeTimeout,
        });

        if (!optResult.success) {
          log(`Optimization failed: ${optResult.error?.slice(0, 200)}`);
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

        // Guardrails check (same as main path)
        const afterSkip = fs.readFileSync(cfg.strategyFile, "utf8");
        const skipViolations = validateGuardrails(beforeContent, afterSkip, cfg.guardrails);
        if (skipViolations.length > 0) {
          log(`Guardrail violations (skip-bt): ${skipViolations.map((v) => v.reason).join("; ")}`);
          fs.writeFileSync(cfg.strategyFile, beforeContent, "utf8");
          continue;
        }
        // Variable count gate
        const skipInputsBefore = countPineInputs(beforeContent);
        const skipInputsAfter = countPineInputs(afterSkip);
        if (state.currentPhase === "refine" && skipInputsAfter - skipInputsBefore > 1) {
          log(`Variable count gate (skip-bt): added ${skipInputsAfter - skipInputsBefore} vars. Rolling back.`);
          fs.writeFileSync(cfg.strategyFile, beforeContent, "utf8");
          continue;
        }
        if (cfg.criteria.maxFreeVariables && skipInputsAfter > cfg.criteria.maxFreeVariables) {
          log(`Variable count gate (skip-bt): ${skipInputsAfter} > max ${cfg.criteria.maxFreeVariables}. Rolling back.`);
          fs.writeFileSync(cfg.strategyFile, beforeContent, "utf8");
          continue;
        }

        // File changed and passed guardrails — clear token so next iter runs a real backtest
        lastBacktestedToken = undefined;
        log("Pine file changed after skip-backtest optimize. Next iter will backtest.");
        continue;
      }

      log("Waiting for Playwright lock...");
      try {
        await acquireLockBlocking("playwright", { timeoutMs: 600000, pollMs: 5000 });
      } catch {
        state.transientFailures++;
        log(`Playwright lock timeout (${state.transientFailures}/${cfg.maxTransientFailures})`);
        if (state.transientFailures > cfg.maxTransientFailures) {
          log("Max transient failures exceeded (lock timeout). Aborting.");
          break;
        }
        continue;
      }
      log("Playwright lock acquired.");

      const iterStartTs = Math.floor(Date.now() / 1000);
      let backtestResult: ReturnType<typeof runBacktest>;
      try {
        log(`Running backtest... (contentToken=${contentToken})`);
        backtestResult = runBacktest({
          repoRoot: cfg.repoRoot,
          strategyFile: cfg.strategyFile,
          chartUrl: cfg.chartUrl,
          headless: process.env.HEADLESS !== "false",
          contentToken,
          asset: cfg.asset,
          dateRange: cfg.dateRange,
        });
      } finally {
        releaseLock("playwright");
        log("Playwright lock released.");
      }

      if (!backtestResult.success) {
        const errClass = classifyError(backtestResult.error || "");
        log(`Backtest failed: ${errClass} — ${backtestResult.error?.slice(0, 200)}`);

        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "BACKTEST_ERROR", status: "error",
          message: `${errClass}: ${backtestResult.error?.slice(0, 100)}`,
        });

        if (errClass === "compile_error") {
          state.fixAttempts++;
          if (state.fixAttempts > cfg.maxFixAttempts) {
            log(`Max fix attempts (${cfg.maxFixAttempts}) exceeded. Aborting.`);
            break;
          }
          log(`Attempting fix (${state.fixAttempts}/${cfg.maxFixAttempts})...`);
          await fixStrategy({ repoRoot: cfg.repoRoot, model: cfg.modelRouting.fix });
          continue;
        }

        if (errClass === "transient_ui" || errClass === "timeout" || errClass === "network") {
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

      const xlsxPath = backtestResult.data!.xlsxPath;
      log(`Backtest OK: ${xlsxPath}`);

      // ---- Step 2: Parse results ----
      log("Parsing XLSX results...");
      const parseResult = parseResults({
        repoRoot: cfg.repoRoot,
        xlsxPath,
        asset: cfg.asset,
        strategy: cfg.strategy,
        strategyFile: cfg.strategyFile,
        iterStartTs,
      });

      if (!parseResult.success || !parseResult.data) {
        log(`Parse failed: ${parseResult.error}`);
        continue;
      }

      const parsed = parseResult.data;
      const metrics = parsed.metrics;
      const currentPnl = metrics.totalPnl ?? 0;

      // ---- Step 2a: Stale XLSX check (before scoring to avoid recording bad metrics) ----
      if (parsed.xlsxStale) {
        state.staleAttempts++;
        log(`Stale XLSX (${state.staleAttempts}/${cfg.maxStaleAttempts})`);
        if (state.staleAttempts > cfg.maxStaleAttempts) {
          log(`Max stale attempts exceeded. Aborting.`);
          break;
        }
        continue;
      }
      state.staleAttempts = 0;

      // ---- Step 2b: Integrity validation ----
      const integrityError = validateIntegrity({
        contentToken,
        xlsxFilename: path.basename(xlsxPath),
        pineParams: parsed.pineParams,
        xlsxParams: parsed.xlsxParams,
      });

      if (integrityError) {
        log(`INTEGRITY: ${integrityError}`);
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "INTEGRITY_MISMATCH", status: "warn", message: integrityError,
        });
        state.integrityAttempts++;
        if (state.integrityAttempts >= 4) {
          log(`Too many integrity mismatches (${state.integrityAttempts}). Aborting.`);
          break;
        }
        if (state.integrityAttempts % 2 === 1) {
          // Odd attempt: retry immediately
          log(`Retrying due to integrity mismatch (${state.integrityAttempts}/4)...`);
          continue;
        }
        // Even attempt: skip this iteration but keep counting
        log(`Integrity mismatch persists (${state.integrityAttempts}/4). Skipping iteration.`);
        continue;
      }
      state.integrityAttempts = 0;

      // ---- Step 2c: Compute score ----
      const scoreResult = computeScore(
        metrics,
        pineContent,
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

      // ---- Step 2d: Backfill previous iteration's result in parameter-history ----
      // Must happen BEFORE any continue/rollback path to prevent infinite loops
      // where failed attempts are never recorded.
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
      // Downgrade accept → neutral when trades < minTrades to prevent false progress signals
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

      // ---- Step 4: Criteria check ----
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
        saveCheckpoint(cfg.checkpointDir, fs.readFileSync(cfg.strategyFile, "utf8"), metrics, iter);
        break;
      }

      // ---- Step 5: Checkpoint / Rollback (score-based) ----
      // Only save checkpoint if minTrades is met — prevents getting stuck on high-score low-trade strategies
      if (scoreResult.weighted > state.bestScore && meetsMinTrades) {
        state.bestScore = scoreResult.weighted;
        state.bestPnl = currentPnl;
        state.bestIter = iter;
        saveCheckpoint(cfg.checkpointDir, fs.readFileSync(cfg.strategyFile, "utf8"), metrics, iter);
        log(`New best: Score=${scoreResult.weighted.toFixed(1)} PnL=$${currentPnl.toFixed(2)} at iter ${iter}`);
      } else if (scoreResult.weighted > state.bestScore && !meetsMinTrades) {
        log(`Score ${scoreResult.weighted.toFixed(1)} is best but trades=${metrics.numTrades} < minTrades=${cfg.criteria.minTrades} — not saving checkpoint`);
      } else if (scoreVerdict === "reject") {
        log(`Rolling back: Score ${scoreResult.weighted.toFixed(1)} dropped below threshold vs best ${state.bestScore.toFixed(1)}`);
        const rolled = rollback(cfg.checkpointDir, cfg.strategyFile);
        if (!rolled) {
          log(`WARNING: Rollback failed — no checkpoint found. Strategy file may be degraded.`);
        }
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "ROLLBACK", status: "warn", pnl: currentPnl,
          message: `Rolled back to best (iter ${state.bestIter}, score=${state.bestScore.toFixed(1)})`,
        });
      }

      state.previousPnl = currentPnl;

      // ---- Step 6: Optimize ----
      const resultJsonPath = path.join(cfg.artifactsDir, `iter${iter}-results.json`);
      fs.writeFileSync(resultJsonPath, JSON.stringify(parsed, null, 2));
      lastBacktestedToken = contentToken;
      lastResultJsonPath = resultJsonPath;

      const beforeContent = fs.readFileSync(cfg.strategyFile, "utf8");

      const isRestructure = state.currentPhase === "restructure" || !!researchBriefPath;
      const optimizeModel = isRestructure && cfg.modelRouting.restructure
        ? cfg.modelRouting.restructure
        : cfg.modelRouting.optimize;
      const optimizeTimeout = isRestructure ? 1800000 : 900000; // 30min Opus, 15min Sonnet
      log(`Optimizing with ${optimizeModel} (phase=${state.currentPhase}, timeout=${optimizeTimeout / 1000}s)...`);

      emitEvent({
        artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
        stage: "OPTIMIZE_START", status: "info",
        message: `phase=${state.currentPhase}`,
      });

      const optResult = await optimizeStrategy({
        repoRoot: cfg.repoRoot,
        resultJsonPath,
        iter,
        maxIter: cfg.maxIter,
        asset: cfg.asset,
        strategy: cfg.strategy,
        strategyFile: cfg.strategyFile,
        model: optimizeModel,
        // When research produced a brief, promote to restructure so the
        // optimize prompt forcefully edits the pine file (research prompt is too soft).
        phase: researchBriefPath ? "restructure" : state.currentPhase,
        researchBriefPath,
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
          // Escalate phase instead of aborting — shouldEscalatePhase will trigger at next iter start
          log(`No-change limit reached — will escalate phase at next iteration.`);
        }
        continue;
      }
      state.noChangeCount = 0;

      // ---- Step 7: Guardrails ----
      log("Checking guardrails...");
      const afterContent = fs.readFileSync(cfg.strategyFile, "utf8");
      const violations = validateGuardrails(beforeContent, afterContent, cfg.guardrails);
      if (violations.length > 0) {
        log(`Guardrail violations: ${violations.map((v) => v.reason).join("; ")}`);
        fs.writeFileSync(cfg.strategyFile, beforeContent, "utf8");
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "GUARDRAIL_VIOLATION", status: "warn",
          message: violations.map((v) => `${v.field}: ${v.reason}`).join("; "),
        });
        continue;
      }

      // ---- Step 7a: Variable count gate ----
      const inputsBefore = countPineInputs(beforeContent);
      const inputsAfter = countPineInputs(afterContent);
      const inputsDelta = inputsAfter - inputsBefore;

      if (state.currentPhase === "refine" && inputsDelta > 1) {
        log(`Variable count gate: refine phase added ${inputsDelta} variables (max 1). Rolling back.`);
        fs.writeFileSync(cfg.strategyFile, beforeContent, "utf8");
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "GUARDRAIL_VIOLATION", status: "warn",
          message: `Refine phase added ${inputsDelta} variables (max 1 per iteration)`,
        });
        continue;
      }

      if (cfg.criteria.maxFreeVariables && inputsAfter > cfg.criteria.maxFreeVariables) {
        log(`Variable count gate: ${inputsAfter} inputs exceeds maxFreeVariables=${cfg.criteria.maxFreeVariables}. Rolling back.`);
        fs.writeFileSync(cfg.strategyFile, beforeContent, "utf8");
        emitEvent({
          artifactsDir: cfg.artifactsDir, runId: cfg.runId, asset: cfg.asset, iter,
          stage: "GUARDRAIL_VIOLATION", status: "warn",
          message: `${inputsAfter} inputs exceeds maxFreeVariables limit of ${cfg.criteria.maxFreeVariables}`,
        });
        continue;
      }

      // ---- Step 7b: Param-writer (deterministic) ----
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
          const { execSync: exec } = await import("node:child_process");
          exec(`git add "${cfg.strategyFile}" && git commit -m "iter${iter}: optimize ${cfg.asset}/${cfg.strategy} (${state.currentPhase})"`, {
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
        message: `Optimized (${state.currentPhase}). Score=${scoreResult.weighted.toFixed(1)}. Diff: ${optResult.data.diff?.split("\n").length ?? 0} lines`,
      });
    }
  }

  // ---- Restore best checkpoint to working file ----
  if (state.bestIter > 0) {
    const restored = rollback(cfg.checkpointDir, cfg.strategyFile);
    if (restored) {
      log(`Restored best checkpoint (iter ${state.bestIter}) to working file`);
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

  // Send WhatsApp summary via Evolution API
  const evoUrl = process.env.EVOLUTION_API_URL;
  const evoKey = process.env.EVOLUTION_API_KEY;
  const evoInstance = process.env.EVOLUTION_INSTANCE || "sexta-feira";
  const recipient = process.env.WHATSAPP_RECIPIENT;

  if (evoUrl && evoKey && recipient) {
    try {
      log("Sending WhatsApp summary...");
      const res = await fetch(`${evoUrl}/message/sendText/${evoInstance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: evoKey },
        body: JSON.stringify({ number: recipient, text: summary }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        log(`WhatsApp send failed: ${res.status} ${errText}`);
      } else {
        log("WhatsApp summary sent");
      }
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
