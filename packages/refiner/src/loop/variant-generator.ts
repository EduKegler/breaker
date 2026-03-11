/**
 * variant-generator.ts — Generates new strategy variants using Claude.
 *
 * Called between runs when the previous variant plateaued. Uses the existing
 * restructure prompt flow: Claude edits the seed strategy file, then the
 * result is forked to a new variant file with a deterministic name.
 */

import fs from "node:fs";
import path from "node:path";

import { buildOptimizePrompt } from "../automation/build-optimize-prompt.js";
import type { RestructureFailure } from "../automation/build-optimize-prompt.js";
import { optimizeStrategy } from "./stages/optimize.js";
import { conductResearch } from "./stages/research.js";
import { checkpoint } from "./stages/checkpoint.js";
import type { VariantManager, VariantInfo } from "./variant-manager.js";
import { selectNextCombination, buildVariantId, fixFactoryName } from "./variant-manager.js";
import type { LoopConfig } from "./types.js";
import type { ModuleContext } from "../lib/build-module-context.js";
import type { Metrics, TradeAnalysis, StrategyParam } from "@breaker/backtest";
import type { ScoreRaw } from "./stages/scoring.js";
import type { ScoringWeights } from "../types/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateVariantOpts {
  cfg: LoopConfig;
  moduleContext: ModuleContext;
  variantManager: VariantManager;
  currentMetrics: Metrics;
  currentAnalysis: TradeAnalysis | null;
  lastStrategyParams: Record<string, StrategyParam>;
  paramOverrides: Record<string, number>;
  scoreBreakdown?: ScoreRaw;
  scoringWeights?: ScoringWeights;
  currentScore: number;
  bestScore: number;
  bestScoreBreakdown?: ScoreRaw;
  globalIter: number;
  kbPath: string;
  /** Absolute path to the SEED strategy file (used as template for Claude). */
  seedStrategyFile: string;
  cancelSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function log(msg: string): void {
  console.log(`\x1b[2m${ts()}\x1b[0m ${msg}`);
}

/**
 * Build failure analysis from variant history for the generation prompt.
 */
export function buildFailureAnalysis(
  variants: readonly { id: string; components: Record<string, string>; bestScore: number; plateauReason?: string }[],
): string {
  if (variants.length === 0) return "";

  const lines = variants.map((v) => {
    const comps = Object.values(v.components).join(" + ") || "seed";
    const reason = v.plateauReason ? ` — ${v.plateauReason}` : "";
    return `- ${v.id} (${comps}): score=${v.bestScore.toFixed(1)}${reason}`;
  });

  return `\n## Previously Tested Variants\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate a new strategy variant using Claude.
 *
 * Flow:
 * 1. Optionally runs research if enabled
 * 2. Claude edits the seed strategy file (restructure prompt)
 * 3. The edited source is saved as a new variant file
 * 4. The seed file is restored from checkpoint
 *
 * Returns the new VariantInfo or null if generation failed.
 */
export async function generateVariant(opts: GenerateVariantOpts): Promise<VariantInfo | null> {
  const {
    cfg, moduleContext, variantManager,
    currentMetrics, currentAnalysis, lastStrategyParams, paramOverrides,
    scoreBreakdown, scoringWeights, currentScore, bestScore, bestScoreBreakdown,
    globalIter, kbPath, seedStrategyFile, cancelSignal,
  } = opts;

  // ---- Optional research (plateau-strong policy) ----
  let researchBriefPath: string | undefined;

  // Research policy: plateau-strong — only run when >=2 variants have been
  // plateaued or killed, indicating the KB catalog alone isn't sufficient.
  const allVariants = variantManager.getAll();
  const finishedVariants = allVariants.filter(
    (v) => v.status === "plateaued" || v.status === "killed",
  );
  const shouldResearch = cfg.research.enabled && finishedVariants.length >= 2;

  if (shouldResearch) {
    log("\x1b[34m\x1b[1mRunning research before variant generation...\x1b[0m");
    const exhaustedApproaches = allVariants.map((v) => v.id);

    const failedRestructures: RestructureFailure[] = allVariants
      .filter((v) => v.status === "plateaued")
      .map((v) => ({
        globalIter: 0,
        trades: 0,
        pf: 0,
        score: v.bestScore,
        diagnosis: `${v.id}: ${Object.values(v.components).join(" + ") || "seed"}`,
      }));

    const researchResult = await conductResearch({
      asset: cfg.asset,
      moduleContext,
      currentMetrics: {
        pnl: currentMetrics.totalPnl ?? 0,
        pf: currentMetrics.profitFactor ?? 0,
        wr: currentMetrics.winRate ?? 0,
        dd: currentMetrics.maxDrawdownPct ?? 0,
        trades: currentMetrics.numTrades ?? 0,
        avgR: currentMetrics.avgR ?? 0,
      },
      failureHistory: failedRestructures.map((f) => ({
        approachName: f.diagnosis ?? "unknown",
        failureMode: `score ${f.score.toFixed(1)}`,
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
      cancelSignal,
    });

    if (researchResult.success) {
      researchBriefPath = path.join(cfg.artifactsDir, "research-brief.json");
      log(`\x1b[32mResearch complete: ${researchResult.data!.suggestedApproaches.length} approaches\x1b[0m`);
    } else {
      log(`\x1b[33mResearch failed (non-blocking): ${researchResult.error}\x1b[0m`);
    }
  } else if (cfg.research.enabled) {
    log(`\x1b[2mSkipping research — only ${finishedVariants.length} variant(s) finished (need >=2)\x1b[0m`);
  }

  // ---- Pre-select next component combination ----
  const testedIds = new Set(allVariants.map((v) => v.id));

  const variantHistory = allVariants.map((v) => ({
    components: v.components,
    bestScore: v.bestScore,
  }));

  const preSelectedComponents = selectNextCombination(moduleContext.catalog, testedIds, variantHistory);
  if (!preSelectedComponents) {
    log("\x1b[33mAll component combinations exhausted — cannot generate new variant\x1b[0m");
    return null;
  }

  const targetVariantId = buildVariantId(preSelectedComponents);
  log(
    `\x1b[34mPre-selected combination: ${targetVariantId} (${Object.entries(preSelectedComponents).map(([s, c]) => `${s}=${c}`).join(", ")})\x1b[0m`,
  );

  // ---- Build restructure prompt with variant history ----
  const failureAnalysis = buildFailureAnalysis(allVariants);

  const failedRestructures: RestructureFailure[] = allVariants
    .filter((v) => v.status === "plateaued")
    .map((v) => ({
      globalIter: 0,
      trades: 0,
      pf: 0,
      score: v.bestScore,
      diagnosis: `${v.id}: ${Object.values(v.components).join(" + ") || "seed"}. ${failureAnalysis ? "See variant history." : ""}`,
    }));

  const prompt = buildOptimizePrompt({
    metrics: currentMetrics,
    tradeAnalysis: currentAnalysis,
    strategySourcePath: seedStrategyFile,
    strategyParams: lastStrategyParams,
    paramOverrides,
    criteria: cfg.criteria,
    asset: cfg.asset,
    moduleContext,
    phase: "restructure",
    iter: 1,
    maxIter: 1,
    globalIter,
    paramHistoryPath: cfg.paramHistoryFile,
    artifactsDir: cfg.artifactsDir,
    researchBriefPath,
    failedRestructures: failedRestructures.length > 0 ? failedRestructures : undefined,
    scoreBreakdown,
    scoringWeights,
    currentScore,
    bestScoreBreakdown,
    bestScore,
    walkForward: currentAnalysis?.walkForward ?? null,
    preSelectedComponents,
  });

  // ---- Run Claude to generate new strategy ----
  const optimizeModel = cfg.modelRouting.restructure ?? cfg.modelRouting.optimize;
  log(`\x1b[34m\x1b[1mGenerating variant with ${optimizeModel}...\x1b[0m`);

  const optResult = await optimizeStrategy({
    prompt,
    strategyFile: seedStrategyFile,
    repoRoot: cfg.repoRoot,
    model: optimizeModel,
    phase: "restructure",
    artifactsDir: cfg.artifactsDir,
    globalIter,
    moduleContext,
    existingParamCount: Object.values(lastStrategyParams).filter((p) => p.optimizable).length,
    timeoutMs: 1800000,
    cancelSignal,
  });

  if (!optResult.success || !optResult.data?.changed) {
    log(`\x1b[33mVariant generation failed or no change: ${optResult.error ?? "no change"}\x1b[0m`);
    return null;
  }

  // ---- Read generated source, fix factory name, and create variant ----
  const generatedSource = fs.readFileSync(seedStrategyFile, "utf8");
  const fixedSource = fixFactoryName(generatedSource, targetVariantId);

  let variant: VariantInfo;
  try {
    variant = variantManager.createVariant(preSelectedComponents, fixedSource);
  } catch (err) {
    log(`\x1b[33mFailed to create variant: ${(err as Error).message}\x1b[0m`);
    checkpoint.rollback(cfg.checkpointDir, seedStrategyFile);
    return null;
  }

  // ---- Restore seed file from checkpoint ----
  checkpoint.rollback(cfg.checkpointDir, seedStrategyFile);

  log(`\x1b[32mVariant ${variant.id} created: ${variant.strategyFile}\x1b[0m`);
  variantManager.save();

  return variant;
}
