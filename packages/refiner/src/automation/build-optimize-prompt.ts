#!/usr/bin/env node
/**
 * build-optimize-prompt.ts
 *
 * Generates the full prompt for the B.R.E.A.K.E.R. TypeScript strategy optimization.
 * Aligned with KB v4.5+ — modules, fixed rules, var caps, stopping criteria.
 *
 * Exported as a function for use by the orchestrator (no subprocess needed).
 */

import fs from "node:fs";
import { z } from "zod";
import { isMainModule } from "@breaker/kit";

import type { Metrics, TradeAnalysis, StrategyParam, SessionName, WalkForward } from "@breaker/backtest";
import type { ResolvedCriteria, CoreParameterDef, ScoringWeights } from "../types/config.js";
import type { ParameterHistory, ApproachRecord, TestedCombination, ParameterHistoryIteration } from "../types/parameter-history.js";
import type { ScoreRaw } from "../loop/stages/scoring.js";
import type { ModuleContext, ComponentCatalog, CatalogSlot } from "../lib/build-module-context.js";
import { MODULE_CRITERIA, computeStretchCriteria } from "../lib/build-module-context.js";
import { safeJsonParse } from "../lib/safe-json.js";
import { paramHistorySchema } from "../lib/param-history-schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestructureFailure {
  globalIter: number;
  trades: number;
  pf: number;
  score: number;
  diagnosis?: string;
}

interface BuildPromptOptions {
  metrics: Metrics;
  tradeAnalysis: TradeAnalysis | null;
  strategySourcePath: string;
  strategyParams: Record<string, StrategyParam>;
  paramOverrides: Record<string, number>;
  criteria: ResolvedCriteria;
  asset: string;
  moduleContext: ModuleContext;
  phase: "refine" | "research" | "restructure";
  iter: number;
  maxIter: number;
  globalIter: number;
  paramHistoryPath: string;
  artifactsDir: string;
  researchBriefPath?: string;
  failedRestructures?: RestructureFailure[];
  lastRollbackReason?: string;
  scoreBreakdown?: ScoreRaw;
  scoringWeights?: ScoringWeights;
  currentScore?: number;
  bestScoreBreakdown?: ScoreRaw;
  bestScore?: number;
  walkForward?: WalkForward | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function buildOptimizePrompt(opts: BuildPromptOptions): string {
  const {
    metrics, tradeAnalysis, strategySourcePath, strategyParams, paramOverrides,
    criteria, asset, moduleContext, phase, iter, maxIter, globalIter,
    paramHistoryPath, artifactsDir, researchBriefPath, failedRestructures,
    lastRollbackReason, scoreBreakdown, scoringWeights, currentScore,
    bestScoreBreakdown, bestScore,
  } = opts;

  // Use KB-aligned criteria for this module, fallback to config
  const mc = MODULE_CRITERIA[moduleContext.moduleId] ?? {
    minTrades: criteria.minTrades ?? 50,
    minPF: criteria.minPF ?? 1.3,
    maxDD: criteria.maxDD ?? 10,
    minWR: criteria.minWR ?? null,
    minAvgR: criteria.minAvgR ?? 0.15,
    minPfRatio: 0.6,
    wrWarnMax: null,
    wrRejectMax: null,
    expectedDegradation: 0.3,
  };

  // Format metrics
  const pnlStr = metrics.totalPnl != null ? `${metrics.totalPnl.toFixed(2)} USD` : "N/A";
  const tradesStr = metrics.numTrades != null ? String(metrics.numTrades) : "N/A";
  const pfStr = metrics.profitFactor != null ? metrics.profitFactor.toFixed(2) : "N/A";
  const ddStr = metrics.maxDrawdownPct != null ? `${Math.abs(metrics.maxDrawdownPct).toFixed(1)}%` : "N/A";
  const wrStr = metrics.winRate != null ? `${metrics.winRate.toFixed(1)}%` : "N/A";
  const avgRStr = metrics.avgR != null ? `${metrics.avgR.toFixed(3)}R` : "N/A";

  // Unmet criteria — module-specific
  const unmetCriteria = buildUnmetCriteria(metrics, mc, pnlStr, tradesStr, pfStr, ddStr, wrStr, avgRStr);

  // Strategy params section
  const paramsSection = buildStrategyParamsSection(strategyParams, paramOverrides, moduleContext.varCap);

  // Trade analysis
  const tradeAnalysisSection = tradeAnalysis ? buildTradeAnalysisSection(tradeAnalysis) : "";

  // Parameter history
  let paramHistory: ParameterHistory | null = null;
  try {
    paramHistory = safeJsonParse(
      fs.readFileSync(paramHistoryPath, "utf8"),
      { schema: paramHistorySchema },
    ) as unknown as ParameterHistory;
  } catch { /* File doesn't exist yet */ }

  const exploredSpaceSection = buildExploredSpaceSection(paramHistory, globalIter, iter, maxIter);
  const pendingHypothesesSection = buildPendingHypothesesSection(paramHistory);
  const approachHistorySection = buildApproachHistorySection(paramHistory);
  const coreParamsSection = buildCoreParamsSection(
    criteria.coreParameters,
    paramHistory?.exploredRanges as Record<string, unknown[]> | undefined,
  );
  const designChecklistSection = buildDesignChecklistSection(criteria.designChecklist, globalIter);
  const filterSimsSection = buildFilterSimsSection(tradeAnalysis);
  const diagnosticGuide = buildDiagnosticGuide(metrics, tradeAnalysis);
  const overfitSection = buildOverfitSection(paramHistory, tradeAnalysis, mc.minPfRatio, metrics, moduleContext.moduleId);

  // Research brief — updated schema matching conduct-research.ts
  const researchSection = buildResearchSection(researchBriefPath);
  const failedRestructuresSection = buildFailedRestructuresSection(failedRestructures);
  const rollbackSection = buildRollbackSection(lastRollbackReason);
  const moduleCriteriaSection = buildModuleCriteriaSection(mc, moduleContext.moduleId);
  const stretchSection = buildStretchSection(moduleContext.moduleId);
  const scoringSection = buildScoringSection(scoreBreakdown, scoringWeights, currentScore);
  const scoreDeltaSection = buildScoreDeltaSection(scoreBreakdown, bestScoreBreakdown, scoringWeights, currentScore, bestScore);
  const walkForwardSection = buildWalkForwardSection(opts.walkForward, mc);
  const lastIterationSection = buildLastIterationSection(paramHistory);
  const exploredSpaceEnriched = buildExploredSpaceEnriched(paramHistory, globalIter, iter, maxIter);

  const metadataPath = `${artifactsDir}/iter${globalIter}-metadata.json`;

  const phaseHeader = phase === "refine"
    ? `Current phase: REFINE (tuning existing parameters within current architecture)`
    : phase === "research"
      ? `Current phase: RESEARCH (search alternatives — brief already produced, implement best)`
      : `Current phase: RESTRUCTURE (implement structural changes to strategy .ts)`;

  // Module context block
  const moduleContextBlock = buildModuleContextBlock(moduleContext);

  // KB constraints block
  const kbConstraintsBlock = buildKBConstraintsBlock(moduleContext);

  // Phase-specific task
  const phaseTask = buildPhaseTask(
    phase, strategySourcePath, metadataPath, paramHistoryPath,
    globalIter, iter, maxIter, pnlStr, tradesStr, wrStr, asset,
    moduleContext, paramHistory, researchBriefPath,
  );

  return `TypeScript strategy optimization loop — iteration ${iter}/${maxIter}.
${phaseHeader}
${rollbackSection}${lastIterationSection}
## CONTEXT
- Asset: ${asset} | Module: ${moduleContext.moduleName} (${moduleContext.moduleId})
- Strategy profile: \`${moduleContext.profile}\`
- Signal TF: ${moduleContext.signalTF} | Regime TF: ${moduleContext.regimeTF}
- Strategy source: \`${strategySourcePath}\`
- Backtest engine: @breaker/backtest (in-process, ~2s per iteration)
- Objective: optimize for Hyperliquid perps

${moduleContextBlock}${moduleCriteriaSection}${stretchSection}
## STOPPING CRITERIA (${moduleContext.moduleId})
${moduleContext.stoppingCriteria}

## UNMET CRITERIA
${unmetCriteria.length ? unmetCriteria.join("\n") : "All criteria met!"}
${diagnosticGuide}## LAST BACKTEST METRICS
PnL: ${pnlStr} | Trades: ${tradesStr} | PF: ${pfStr} | DD: ${ddStr} | WR: ${wrStr} | AvgR: ${avgRStr}
Avg Win: ${metrics.avgWinR != null ? `${metrics.avgWinR.toFixed(2)}R` : "N/A"} | Avg Loss: ${metrics.avgLossR != null ? `${metrics.avgLossR.toFixed(2)}R` : "N/A"} | Max Loss: ${metrics.maxLossR != null ? `${metrics.maxLossR.toFixed(2)}R` : "N/A"} | Expectancy: ${metrics.expectancy != null ? `${metrics.expectancy.toFixed(3)}R/trade` : "N/A"}${metrics.avgWinR != null && metrics.avgLossR != null && Math.abs(metrics.avgLossR) > 0 ? `\nR:R ratio: ${(metrics.avgWinR / Math.abs(metrics.avgLossR)).toFixed(2)} (${metrics.avgWinR / Math.abs(metrics.avgLossR) < 1.2 ? "⚠️ near-symmetric — breakout/trend strategies need R:R > 1.5" : "OK"})` : ""}

${scoringSection}${scoreDeltaSection}${walkForwardSection}
${designChecklistSection}${paramsSection}
${kbConstraintsBlock}${overfitSection}${tradeAnalysisSection}
${filterSimsSection}${exploredSpaceEnriched || exploredSpaceSection}${coreParamsSection}${pendingHypothesesSection}${approachHistorySection}${researchSection}${failedRestructuresSection}
${phaseTask}

## STRATEGY INTERFACE REFERENCE
\`\`\`typescript
interface StrategyParam {
  value: number;
  min: number;
  max: number;
  step: number;
  optimizable: boolean;
  description?: string;
}
interface StrategyContext {
  candles: Candle[];
  index: number;
  currentCandle: Candle;
  positionDirection: "long" | "short" | null;
  positionEntryPrice: number | null;       // entry price of current position
  positionEntryBarIndex: number | null;    // bar index at entry (for barsInTrade calc)
  higherTimeframes: Record<string, Candle[]>;
  dailyPnl: number;                        // realized PnL for the current day
  tradesToday: number;                     // trades taken today
  barsSinceExit: number;                   // bars since last exit (cooldown)
  track(name: string, passed: boolean, value?: number, threshold?: number): boolean;
  indicator(name: string, value: number): void;
}
interface Strategy {
  name: string;
  params: Record<string, StrategyParam>;
  requiredTimeframes: string[];          // MANDATORY — runner loads these HTFs
  requiredWarmup?: Record<string, number>;
  init?(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void;
  onCandle(ctx: StrategyContext): Signal | null;
  shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null; // MANDATORY
  computeLevels(ctx: StrategyContext, direction: "long" | "short"): { stopLoss: number; takeProfits: { price: number; pctOfPosition: number }[] } | null; // MANDATORY
  getExitLevel?(ctx: StrategyContext): number | null;
}
\`\`\`

## OPTIMIZATION RULES
- **1 change per iteration** (refine phase): change ONE param value. Restructure can make larger changes.
- **Variable cap: ${moduleContext.varCap}** — current optimizable params must not exceed this. Adding a param requires dropping another.
- **Core parameters first**: sweep core parameter ranges before secondary params.
- **Early exit from sweep**: if 3+ consecutive tested values for the same param ALL degrade vs the best score, the param is **directionally exhausted** — stop sweeping that direction, mark the param as done, and move to the next param or direction. Do NOT continue testing remaining values when the trend is clearly negative.
- **FORBIDDEN: day-of-week filters**. No dayofweek conditions.
- **FORBIDDEN: hour-of-day filters**. Use adaptive volume/volatility filters instead of time gates.
- **Axis exhaustion**: a core param is EXHAUSTED when every value has been tested OR when directionally exhausted (3+ consecutive degradations).
- **Directional bias**: if one direction PF < 0.5, diagnosis is STRUCTURAL.
- **Next steps are conditionals**: use format "if [metric X] then [action Y]".
- **FORBIDDEN: category change**. Strategy archetype (${moduleContext.profile}) MUST NOT change without RESTRUCTURE approval.
- **FORBIDDEN: violating fixed rules**. See MODULE FIXED RULES above — these are hard constraints.
- **MANDATORY diagnostics**: every entry condition MUST use \`ctx.track(name, passed, value, threshold)\` and intermediate values MUST use \`ctx.indicator(name, value)\`. Track calls use "L:" or "S:" prefix per direction. Removal is FORBIDDEN — the guardrail will reject the iteration.
- **MANDATORY computeLevels()**: strategy MUST implement \`computeLevels(ctx, direction)\` returning \`{ stopLoss, takeProfits }\`. Used by \`/quick-signal\` for manual signals. Removal is FORBIDDEN.
- **pctOfPosition is a FRACTION (0-1), NOT a percentage**. Use \`0.50\` for 50%, \`1.0\` for 100%. The engine multiplies \`size * pctOfPosition\` directly — using \`50\` instead of \`0.50\` creates a 50x order and inflates commission 100x. This is a hard constraint enforced at runtime.
- **MANDATORY shouldExit()**: strategy MUST implement \`shouldExit(ctx)\` with timeout check (\`barsInTrade >= timeoutBars\`) as first exit condition. Removal is FORBIDDEN.
- **MANDATORY requiredTimeframes**: strategy MUST declare \`requiredTimeframes\` array. Without it, the runner won't load HTF candles and all signals return null.
- **MANDATORY anti-repaint HTF**: HTF indicator lookups MUST use the completed-bar pattern: reverse loop checking \`.t + MS_1H <= currentCandle.t\` (or MS_4H/MS_1D). Using \`htfIndicator[last]\` directly repaints. Removal or simplification is FORBIDDEN.
`;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildModuleContextBlock(mc: ModuleContext): string {
  const lines = [
    `## MODULE FIXED RULES (${mc.moduleId} — BREAKER cannot change these)`,
    mc.fixedRules,
  ];

  if (mc.restructureLocks) {
    lines.push("");
    lines.push(`## RESTRUCTURE LOCKS (architecture decisions already made — do NOT change during REFINE)`);
    lines.push(mc.restructureLocks);
    lines.push(`Changing these requires explicit RESTRUCTURE phase approval.`);
  }

  return lines.join("\n") + "\n\n";
}

function buildKBConstraintsBlock(mc: ModuleContext): string {
  const lines = ["## KB CONSTRAINTS (apply to all phases)"];

  // Module-specific constraints
  if (mc.moduleId === "M1" || mc.moduleId === "M4") {
    lines.push(`- Order type: IOC (taker, 0.045%). Price moves away from entry — maker orders systematically rejected.`);
  } else {
    lines.push(`- Order type: ALO (maker, 0.015%). Price comes toward entry level. Backtest uses taker (pessimistic) — real performance slightly better.`);
  }

  if (mc.moduleId === "M4") {
    lines.push(`- Funding: subtracted bar-by-bar during trade (not at close). Uses oracle_price for notional. Cap 4%/hour.`);
    lines.push(`- Stop: ATR Daily × multiplier. Multiplier MUST be >= 3.0 (hard floor from rule 4).`);
    lines.push(`- Exit precedence: hard stop first → trailing (SuperTrend flip) → timeout. Whichever triggers first.`);
    lines.push(`- Long/short asymmetry: test long-only, asymmetric sizing, and symmetric modes.`);
  }

  if (mc.moduleId === "M2") {
    lines.push(`- WR gate: mandatory >= 50% (MR profits from frequent small wins — low WR = design failure).`);
    lines.push(`- No-stop variant: only if liq distance >= 2x widest stop (see KB 9.3). Use virtual stop for sizing.`);
  }

  if (mc.moduleId === "M3") {
    lines.push(`- Swing detection: must be causal (no future bars). Same definition for depth filter, stop, and TP.`);
    lines.push(`- Stop: at invalidation level + buffer. ATR × hardCap is ENTRY FILTER (skip if wider), NOT a cap.`);
    lines.push(`- R:R filter: skip trade if projected R:R < 1.0. Late confirmation needs further TP (Fib extension).`);
  }

  // Universal constraints
  lines.push(`- Anti-lookahead: HTF indicators (${mc.regimeTF}) must use only the last fully closed candle.`);
  lines.push(`- Walk-forward split: train 70% / test 30% (KB §10.1). pfRatio = testPF / trainPF >= 0.6.`);
  lines.push(`- Backtest fees: taker 0.045% all operations (intentionally pessimistic).`);
  lines.push(`- Slippage: 10 bps modeled. Daemon entry tolerance: 50 bps max.`);
  lines.push(`- Leverage: BTC 5x, SOL 3x. Liq distance >= 2x widest stop.`);

  return lines.join("\n") + "\n\n";
}

function buildUnmetCriteria(
  metrics: Metrics,
  mc: { minTrades: number; minPF: number; maxDD: number; minWR: number | null; minAvgR: number | null; minPfRatio: number },
  pnlStr: string, tradesStr: string, pfStr: string, ddStr: string, wrStr: string, avgRStr: string,
): string[] {
  const unmet: string[] = [];

  if ((metrics.totalPnl ?? 0) <= 0)
    unmet.push(`- Total P&L must be > 0 USD (current: ${pnlStr})`);
  if ((metrics.numTrades ?? 0) < mc.minTrades)
    unmet.push(`- Trade count must be >= ${mc.minTrades} (current: ${tradesStr})`);
  if ((metrics.profitFactor ?? 0) < mc.minPF)
    unmet.push(`- Profit Factor must be >= ${mc.minPF} (current: ${pfStr})`);
  if (Math.abs(metrics.maxDrawdownPct ?? 100) > mc.maxDD)
    unmet.push(`- Max Drawdown must be <= ${mc.maxDD}% (current: ${ddStr})`);

  // WR gate: only for modules that require it (M2)
  if (mc.minWR !== null && (metrics.winRate ?? 0) < mc.minWR)
    unmet.push(`- Win Rate must be >= ${mc.minWR}% (current: ${wrStr}) [mandatory for this module]`);

  // avgR gate: only for modules that require it (M1, M3, M4)
  if (mc.minAvgR !== null && (metrics.avgR ?? 0) < mc.minAvgR)
    unmet.push(`- Avg R/trade must be >= ${mc.minAvgR}R (current: ${avgRStr})`);

  return unmet;
}

function buildDiagnosticGuide(metrics: Metrics, tradeAnalysis: TradeAnalysis | null): string {
  const hints: string[] = [];

  const pf = metrics.profitFactor ?? 0;
  const wr = metrics.winRate ?? 0;
  const avgWinR = metrics.avgWinR ?? 0;
  const avgLossR = Math.abs(metrics.avgLossR ?? 0);
  const rr = avgLossR > 0 ? avgWinR / avgLossR : 0;

  if (pf < 1.0) {
    if (rr > 0 && rr < 1.2) hints.push("PF<1: R:R ratio near 1.0 → problem is exits (SL/TP placement). Widen TP or tighten SL.");
    if (wr < 30) hints.push("PF<1: WR < 30% → problem is entry selectivity (too many fakeouts). Add filters or stricter conditions.");
    if (tradeAnalysis) {
      const signalExits = (tradeAnalysis.byExitType ?? []).filter((e) => e.signal === "signal" || e.signal === "timeout");
      const totalExits = tradeAnalysis.totalExitRows ?? 1;
      const signalPct = signalExits.reduce((s, e) => s + e.count, 0) / totalExits;
      if (signalPct > 0.6) hints.push("PF<1: >60% exits via timeout/signal → TP/SL never hit. Increase timeout bars or adjust targets.");
    }
  }

  if (tradeAnalysis) {
    const worstPnl = tradeAnalysis.worst3TradesPnl ?? [];
    const worstSum = Math.abs(worstPnl.reduce((s, v) => s + v, 0));
    const totalPnl = Math.abs(metrics.totalPnl ?? 0);
    if (totalPnl > 0 && worstSum > totalPnl * 0.5) hints.push("DD high: worst 3 trades account for >50% of total loss → outlier risk. Consider tighter SL.");

    const dirs = tradeAnalysis.byDirection;
    if (dirs) {
      const longPf = dirs.Long?.profitFactor ?? 0;
      const shortPf = dirs.Short?.profitFactor ?? 0;
      if (longPf < 0.5 && shortPf > 0.8) hints.push("DD: long direction PF < 0.5 — consider disabling or filtering long entries.");
      if (shortPf < 0.5 && longPf > 0.8) hints.push("DD: short direction PF < 0.5 — consider disabling or filtering short entries.");
    }
  }

  if (hints.length === 0) return "";
  return "\n## DIAGNOSTIC GUIDE (causal analysis)\n" + hints.map((h) => `- ${h}`).join("\n") + "\n\n";
}

function buildStrategyParamsSection(
  params: Record<string, StrategyParam>,
  overrides: Record<string, number>,
  varCap: number,
): string {
  const lines = ["## CURRENT STRATEGY PARAMETERS"];
  const optimizable: string[] = [];
  const fixed: string[] = [];

  for (const [name, param] of Object.entries(params)) {
    const current = overrides[name] ?? param.value;
    const range = `[${param.min}, ${param.max}] step=${param.step}`;
    const line = `${name}=${current} ${range}${param.description ? ` — ${param.description}` : ""}`;
    if (param.optimizable) {
      optimizable.push(line);
    } else {
      fixed.push(line);
    }
  }

  if (optimizable.length) {
    lines.push("Optimizable:");
    for (const l of optimizable) lines.push(`  ${l}`);
  }
  if (fixed.length) {
    lines.push("Fixed (non-optimizable):");
    for (const l of fixed) lines.push(`  ${l}`);
  }

  const varStatus = optimizable.length > varCap
    ? `⚠️ OVER CAP (${optimizable.length}/${varCap}) — must drop ${optimizable.length - varCap} param(s)`
    : `${optimizable.length}/${varCap}`;

  lines.push(`\nOptimizable params: ${varStatus}`);
  return lines.join("\n") + "\n\n";
}

function buildPhaseTask(
  phase: string, strategySourcePath: string, metadataPath: string,
  paramHistoryPath: string, globalIter: number, iter: number, maxIter: number,
  pnlStr: string, tradesStr: string, wrStr: string, asset: string,
  moduleContext: ModuleContext, paramHistory: ParameterHistory | null,
  researchBriefPath?: string,
): string {
  if (phase === "refine") {
    return `## TASK (phase: REFINE)

0. **DIAGNOSTIC** (REQUIRED):
   - Classify: PARAMETRIC vs STRUCTURAL
   - If STRUCTURAL: recommend "escalate to research" in phaseRecommendation
   - Check: does current param count exceed var cap (${moduleContext.varCap})? If yes, must DROP a param.

1. **Check previous prediction**: read "Next steps if fails" from last iteration.
2. **Analyze** — form hypotheses. Consider:
   - Which stopping criteria are unmet and by how much?
   - Which direction (long/short) is dragging performance?
   - Which session has worst performance?
   - Is the issue WR (too few wins) or R:R (wins too small)?
3. **Rank hypotheses**:
   | # | Hypothesis | Est. ΔTrades | Est. ΔPnL | Confidence | Reversibility |
   Sort by impact. Apply ONLY #1.
4. **Verify rule compliance**: does the proposed change violate any fixed rule? If yes, reject it.
5. **Output param change** as JSON to stdout:
\`\`\`json
{ "paramOverrides": { "paramName": newValue } }
\`\`\`
   Only change ONE param per iteration in refine phase.
   Value MUST be within the param's [min, max] range.
6. **Write metadata** to \`${metadataPath}\`:
\`\`\`json
{
  "changeApplied": { "param": "...", "from": ..., "to": ..., "scale": "parametric", "description": "..." },
  "hypotheses": [{"rank": 1, "hypothesis": "...", "confidence": "High", "applied": true}],
  "diagnostic": { "type": "parametric", "rootCause": "..." },
  "expectedResult": { "metric": "PnL", "direction": "up", "estimate": "+10-15%" },
  "nextSteps": [{"condition": "PnL < 180", "action": "revert change"}],
  "ruleCompliance": "All fixed rules satisfied"
}
\`\`\`
   Do NOT edit \`${paramHistoryPath}\`.
7. **Output summary** as the LAST line of your response:
   \`SUMMARY: <one-line description of what you did and why, max 150 chars>\``;
  }

  if (phase === "research") {
    // Research phase with brief: implement the best approach from the brief
    // Research phase without brief: research failed, make a structural improvement using KB catalog
    const hasBrief = !!researchBriefPath;

    const catalogFallback = formatCatalogForPrompt(
      moduleContext.catalog,
      paramHistory?.testedCombinations ?? [],
      moduleContext.restructureLocks,
    );

    return `## TASK (phase: RESEARCH → IMPLEMENT)

${hasBrief ? `A research brief has been produced. See RECENT RESEARCH section above.
Select the approach with best compliance and expected metrics, then implement it.` :
`Research did not produce a brief. Use the KB component catalog below to select an untested combination and implement it.

${catalogFallback}`}

### Instructions
1. **Implement** in \`${strategySourcePath}\`:
   - Must comply with ALL fixed rules for ${moduleContext.moduleId}
   - Must stay within ${moduleContext.varCap} var cap
   - Must respect RESTRUCTURE locks (if any)
2. **Run** \`pnpm --filter @breaker/backtest typecheck\` to validate
3. **Write metadata** to \`${metadataPath}\` with scale: "structural"
   Do NOT edit \`${paramHistoryPath}\`.

CRITICAL: Do NOT run WebSearch. Focus on clean implementation.
4. **Output summary** as the LAST line of your response:
   \`SUMMARY: <one-line description of what you did and why, max 150 chars>\``;
  }

  // restructure — catalog-driven
  const catalogSection = formatCatalogForPrompt(
    moduleContext.catalog,
    paramHistory?.testedCombinations ?? [],
    moduleContext.restructureLocks,
  );

  return `## TASK (phase: RESTRUCTURE)

**CRITICAL**: EDIT \`${strategySourcePath}\`. You must SELECT components from the KB catalog below. Do NOT invent new components outside the catalog.

${catalogSection}

### Instructions

1. **SELECT** one component per slot from the catalog above
   - Prioritize combinations NOT YET TESTED
   - Total vars across all selected components must be <= ${moduleContext.varCap}
   - Must comply with ALL fixed rules for ${moduleContext.moduleId}
2. **IMPLEMENT** the selected combination in \`${strategySourcePath}\`
3. **Run** \`pnpm --filter @breaker/backtest typecheck\` to validate
4. **Write metadata** to \`${metadataPath}\`:
\`\`\`json
{
  "scale": "structural",
  "selectedComponents": { "Slot Name": "slug" },
  "totalVars": <number>,
  "restructureLockChanged": "<which lock changed, or null>",
  "ruleCompliance": "<check each fixed rule>",
  "rationale": "<why this combination>"
}
\`\`\`
   Do NOT edit \`${paramHistoryPath}\`.
5. **Output summary** as the LAST line of your response:
   \`SUMMARY: <one-line description of what you did and why, max 150 chars>\``;
}

/**
 * Parse restructureLocks string (e.g. "regime: EMA direction, entry: Donchian Channel")
 * into a map of slot name → locked candidate name.
 */
function parseLocks(restructureLocks: string): Map<string, string> {
  const locks = new Map<string, string>();
  if (!restructureLocks) return locks;

  for (const part of restructureLocks.split(",")) {
    const [key, ...rest] = part.split(":");
    if (key && rest.length > 0) {
      locks.set(key.trim().toLowerCase(), rest.join(":").trim());
    }
  }
  return locks;
}

/**
 * Match a slot name to a lock key using fuzzy matching.
 */
function findLock(slotName: string, locks: Map<string, string>): string | undefined {
  const lower = slotName.toLowerCase();
  if (locks.has(lower)) return locks.get(lower);
  for (const [key, val] of locks) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return undefined;
}

/**
 * Validate slug-based component selections from Claude's metadata.
 * Each value must be a valid slug for its slot. Invalid entries are dropped.
 * Returns only valid { slotName: slug } entries.
 */
export function validateSlugComponents(
  components: Record<string, string>,
  catalog: ComponentCatalog,
): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [slotName, slug] of Object.entries(components)) {
    const slot = catalog.slots.find((s) => s.slotName === slotName);
    if (!slot) continue; // unknown slot — drop
    const match = slot.candidates.find((c) => c.slug === slug);
    if (!match) continue; // unknown slug for this slot — drop
    validated[slotName] = slug;
  }
  return validated;
}

/**
 * Check if a candidate's slug has been tested in any combination for a slot.
 * Uses exact slug comparison — no fuzzy matching needed.
 */
function isCandidateTested(
  candidateSlug: string,
  slotName: string,
  testedCombinations: TestedCombination[],
): boolean {
  return testedCombinations.some((tc) => {
    const tcSlug = tc.components[slotName];
    return tcSlug === candidateSlug;
  });
}

export function formatCatalogForPrompt(
  catalog: ComponentCatalog,
  testedCombinations: TestedCombination[],
  restructureLocks?: string,
): string {
  if (catalog.slots.length === 0) {
    return "### Component Catalog\n(No catalog available — KB not loaded. Apply structural rewrite using your best judgment.)";
  }

  const locks = parseLocks(restructureLocks ?? "");

  const lines: string[] = ["### Component Catalog (from Knowledge Base)"];
  lines.push("");
  lines.push("Select ONE component per slot. You CANNOT invent new components outside this list.");
  lines.push("Use the SLUG (backtick code) in your metadata `selectedComponents`, NOT the full name.");
  lines.push('Example: `"Entry Signal": "donchian"` NOT `"Entry Signal": "Donchian Channel"`.');
  lines.push("");

  for (const slot of catalog.slots) {
    const varsStr = slot.typicalVars ? ` (${slot.typicalVars} vars)` : "";
    const lockedName = findLock(slot.slotName, locks);
    lines.push(`**${slot.slotName}${varsStr}:**`);

    for (let i = 0; i < slot.candidates.length; i++) {
      const c = slot.candidates[i];
      const tested = isCandidateTested(c.slug, slot.slotName, testedCombinations);
      const isLocked = lockedName && c.name.toLowerCase().includes(lockedName.toLowerCase());
      const markers: string[] = [];
      if (isLocked) markers.push("LOCKED");
      if (tested) markers.push("TESTED");
      const markerStr = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
      lines.push(`  ${i + 1}. \`${c.slug}\` — ${c.name}${markerStr}: ${c.description}`);
    }
    lines.push("");
  }

  if (locks.size > 0) {
    lines.push("> **RESTRUCTURE locks**: Components marked [LOCKED] are the current architecture.");
    lines.push("> You may change a lock, but must explicitly declare it in metadata `restructureLockChanged`.");
    lines.push("");
  }

  if (testedCombinations.length > 0) {
    lines.push("### Previously Tested Combinations");
    lines.push("");
    for (const tc of testedCombinations) {
      const slots = Object.entries(tc.components)
        .map(([slot, name]) => `${slot}=${name}`)
        .join(", ");
      const metricsStr = tc.bestMetrics
        ? `PF=${tc.bestMetrics.pf}, WR=${tc.bestMetrics.wr}%, DD=${tc.bestMetrics.dd}%, trades=${tc.bestMetrics.trades}`
        : "no metrics";
      lines.push(`- iter ${tc.iter}: ${slots} → ${metricsStr}`);
    }
    lines.push("");
    lines.push("**Do NOT repeat a combination that has already been tested. Choose untested components.**");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// P1.1: Scoring transparency — show weights and component breakdown
// ---------------------------------------------------------------------------

function buildScoringSection(
  breakdown?: ScoreRaw,
  weights?: ScoringWeights,
  total?: number,
): string {
  if (!breakdown || !weights) return "";
  const fmt = (raw: number, w: number) => `${(raw * w).toFixed(1)}/${w}`;
  return `## SCORING FUNCTION (guides iteration acceptance)
Weights: PF=${weights.pf}% | avgR=${weights.avgR}% | Sample=${weights.sampleConfidence}% | DD=${weights.dd}% | Complexity=${weights.complexity}% | WR=${weights.wr}%
Current breakdown: PF=${fmt(breakdown.pf, weights.pf)} | avgR=${fmt(breakdown.avgR, weights.avgR)} | WR=${fmt(breakdown.wr, weights.wr)} | DD=${fmt(breakdown.dd, weights.dd)} | Complex=${fmt(breakdown.complexity, weights.complexity)} | Sample=${fmt(breakdown.sampleConfidence, weights.sampleConfidence)}
Total: ${total?.toFixed(1) ?? "?"}/100
→ Focus on the LOWEST-scoring component with the HIGHEST weight for maximum improvement.

`;
}

// ---------------------------------------------------------------------------
// P1.2: Score delta vs best — which component improved/degraded
// ---------------------------------------------------------------------------

function buildScoreDeltaSection(
  current?: ScoreRaw,
  best?: ScoreRaw,
  weights?: ScoringWeights,
  currentTotal?: number,
  bestTotal?: number,
): string {
  if (!current || !best || !weights || currentTotal == null || bestTotal == null) return "";
  if (currentTotal >= bestTotal) return ""; // Only show delta when behind

  const keys: (keyof ScoreRaw)[] = ["pf", "avgR", "wr", "dd", "complexity", "sampleConfidence"];
  const labels: Record<string, string> = { pf: "PF", avgR: "avgR", wr: "WR", dd: "DD", complexity: "Complex", sampleConfidence: "Sample" };

  const deltas = keys.map((k) => {
    const delta = (current[k] - best[k]) * weights[k];
    const sign = delta >= 0 ? "+" : "";
    return `${labels[k]} ${sign}${delta.toFixed(1)}`;
  });

  // Find largest negative contributor
  let worstKey = keys[0];
  let worstDelta = 0;
  for (const k of keys) {
    const d = (current[k] - best[k]) * weights[k];
    if (d < worstDelta) { worstDelta = d; worstKey = k; }
  }

  const hint = worstDelta < -1
    ? `\n→ ${labels[worstKey]} dropped the most (${worstDelta.toFixed(1)}). Fix this component first.`
    : "";

  return `## SCORE DELTA vs BEST (${currentTotal.toFixed(1)} vs ${bestTotal.toFixed(1)})
${deltas.join(" | ")}${hint}

`;
}

// ---------------------------------------------------------------------------
// P2.1: Last iteration result — cause-effect for learning
// ---------------------------------------------------------------------------

function buildLastIterationSection(paramHistory: ParameterHistory | null): string {
  if (!paramHistory?.iterations?.length) return "";
  const last = paramHistory.iterations[paramHistory.iterations.length - 1];
  if (!last) return "";

  const afterStr = last.after
    ? `PnL=$${last.after.pnl.toFixed(2)}, PF=${last.after.pf.toFixed(2)}, trades=${last.after.trades}`
    : "no metrics";
  const beforeStr = last.before
    ? `PnL=$${last.before.pnl.toFixed(2)}, PF=${last.before.pf.toFixed(2)}, trades=${last.before.trades}`
    : "no baseline";

  const changeStr = last.change
    ? `Changed: ${last.change.param} from ${last.change.from} to ${last.change.to}`
    : `Structural change (restructure)`;

  // Skip if pending (no result yet)
  if (last.verdict === "pending") return "";

  return `## LAST ITERATION RESULT
${changeStr}
Before: ${beforeStr}
After: ${afterStr}
Verdict: ${last.verdict}${last.note ? ` — ${last.note}` : ""}
→ Use this cause-effect data to inform your next change. Do NOT repeat changes that degraded metrics.

`;
}

// ---------------------------------------------------------------------------
// P2.2: Explored ranges enriched with metrics per value
// ---------------------------------------------------------------------------

function buildExploredSpaceEnriched(
  paramHistory: ParameterHistory | null,
  globalIter: number, iter: number, maxIter: number,
): string {
  if (!paramHistory) return "";

  // Build per-param metric map from iteration history
  const paramMetrics = new Map<string, Array<{ value: unknown; pf: number; trades: number }>>();
  for (const it of paramHistory.iterations) {
    if (!it.change || !it.after) continue;
    const key = it.change.param;
    if (!paramMetrics.has(key)) paramMetrics.set(key, []);
    paramMetrics.get(key)!.push({
      value: it.change.to,
      pf: it.after.pf,
      trades: it.after.trades,
    });
  }

  const lines = ["## EXPLORED SPACE"];
  let hasContent = false;

  const ranges = paramHistory.exploredRanges ?? {};
  const rangeEntries = Object.entries(ranges).filter(([, vals]) => Array.isArray(vals) && vals.length > 0);
  if (rangeEntries.length) {
    for (const [param, values] of rangeEntries) {
      const metricsForParam = paramMetrics.get(param);
      if (metricsForParam && metricsForParam.length > 0) {
        // Show values with metrics
        const valueMetrics = (values as unknown[]).map((v) => {
          const m = metricsForParam.find((pm) => String(pm.value) === String(v));
          return m ? `${v} (PF=${m.pf.toFixed(2)})` : `${v}`;
        });
        // Find sweet spot
        const bestEntry = metricsForParam.reduce((best, curr) =>
          curr.pf > best.pf ? curr : best, metricsForParam[0]);
        lines.push(`${param}: ${valueMetrics.join(" → ")}`);
        if (bestEntry && metricsForParam.length >= 2) {
          lines.push(`  Sweet spot: ~${bestEntry.value} (best PF=${bestEntry.pf.toFixed(2)})`);
        }
      } else {
        lines.push(`${param}: tested [${(values as unknown[]).join(", ")}]`);
      }
      hasContent = true;
    }
  }

  const neverWorked = paramHistory.neverWorked ?? [];
  if (neverWorked.length) {
    lines.push("\nNever worked:");
    for (const item of neverWorked) {
      const label = typeof item === "string"
        ? item
        : `${item.param}=${item.value} [${item.reason ?? "?"}]`;
      lines.push(`- ${label}`);
    }
    hasContent = true;
  }

  lines.push(`\nGlobal iteration: ${globalIter} (loop iter ${iter}/${maxIter})`);
  if (!hasContent) return "";
  return lines.join("\n") + "\n\n";
}

function buildResearchSection(researchBriefPath?: string): string {
  if (!researchBriefPath) return "";

  const researchBriefSchema = z.object({
    module: z.string().optional(),
    suggestedApproaches: z.array(z.object({
      name: z.string(),
      indicators: z.array(z.string()),
      entryLogic: z.string(),
      exitLogic: z.string().default("(not specified)"),
      rationale: z.string(),
      estimatedVars: z.number().default(0),
      complianceNotes: z.string().default(""),
      expectedMetrics: z.object({
        estimatedWR: z.string().default("unknown"),
        estimatedPF: z.string().default("unknown"),
        estimatedAvgR: z.string().default("unknown"),
      }).default({}),
    })).default([]),
  }).passthrough();

  try {
    const brief = safeJsonParse(
      fs.readFileSync(researchBriefPath, "utf8"),
      { repair: true, schema: researchBriefSchema },
    );

    if (!brief.suggestedApproaches?.length) return "";

    const approaches = brief.suggestedApproaches.map((a) => {
      const em = a.expectedMetrics ?? { estimatedWR: "unknown", estimatedPF: "unknown", estimatedAvgR: "unknown" };
      return [
        `### ${a.name} (${a.estimatedVars} vars)`,
        `**Indicators:** ${a.indicators.join(", ")}`,
        `**Entry:** ${a.entryLogic}`,
        `**Exit:** ${a.exitLogic}`,
        `**Rationale:** ${a.rationale}`,
        `**Expected:** WR=${em.estimatedWR}, PF=${em.estimatedPF}, avgR=${em.estimatedAvgR}`,
        `**Compliance:** ${a.complianceNotes || "(not assessed)"}`,
      ].join("\n");
    }).join("\n\n");

    return `## RECENT RESEARCH (implement best approach)\n${approaches}\n\n`;
  } catch {
    return "";
  }
}

function buildTradeAnalysisSection(ta: TradeAnalysis): string {
  const exitLines = (ta.byExitType ?? [])
    .map((e) => `  ${e.signal.padEnd(18)}: ${String(e.count).padStart(3)}t | WR=${String(e.winRate).padStart(5)}% | PnL=${e.pnl >= 0 ? "+" : ""}${e.pnl} USD`)
    .join("\n") || "  (no data)";

  // Structural diagnostics derived from trade data
  const diagnostics = buildStructuralDiagnostics(ta);

  return `## TRADE ANALYSIS
By exit type:
${exitLines}

Average duration: winners=${ta.avgBarsWinners ?? "?"} bars | losers=${ta.avgBarsLosers ?? "?"} bars

By direction:
${Object.entries(ta.byDirection)
  .map(([d, v]) => `  ${d}: ${v.count}t, PnL=${v.pnl >= 0 ? "+" : ""}${v.pnl}, WR=${v.winRate}%, PF=${v.profitFactor ?? "?"}`)
  .join("\n")}

${ta.bySession ? `By session:\n${(["Asia", "London", "NY", "Off-peak"] as SessionName[]).map((s) => {
  const ss = ta.bySession![s];
  return `  ${s.padEnd(9)}: ${String(ss.count).padStart(3)}t | WR=${String(ss.winRate).padStart(5)}% | PF=${String(ss.profitFactor).padStart(5)} | PnL=${ss.pnl >= 0 ? "+" : ""}${ss.pnl} USD`;
}).join("\n")}` : ""}

By day of week:
${Object.entries(ta.byDayOfWeek ?? {})
  .sort((a, b) => b[1].pnl - a[1].pnl)
  .map(([day, stats]) => `  ${day.padEnd(4)}: ${String(stats.count).padStart(3)}t | PnL=${stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)} USD`)
  .join("\n") || "  (no data)"}

Best trades: ${ta.best3TradesPnl.join(", ")} USD | Worst: ${ta.worst3TradesPnl.join(", ")} USD
${diagnostics}`;
}

/**
 * Build explicit structural diagnostic warnings from trade analysis.
 * These highlight patterns Claude should address — timeout dominance, R:R symmetry, etc.
 */
function buildStructuralDiagnostics(ta: TradeAnalysis): string {
  const warnings: string[] = [];
  const totalTrades = ta.totalExitRows ?? 0;
  if (totalTrades === 0) return "";

  // 1. Timeout dominance: if timeout exits > 50%, the strategy isn't capturing moves
  const timeoutExit = (ta.byExitType ?? []).find((e) => e.signal === "timeout" || e.signal === "signal");
  const tpExits = (ta.byExitType ?? []).filter((e) => e.signal.startsWith("tp"));
  const tpCount = tpExits.reduce((sum, e) => sum + e.count, 0);
  const slExits = (ta.byExitType ?? []).filter((e) => e.signal === "sl");
  const slCount = slExits.reduce((sum, e) => sum + e.count, 0);

  // Check for "signal" exits which are typically trail/timeout
  const signalExit = (ta.byExitType ?? []).find((e) => e.signal === "signal");
  const timeoutExitEntry = (ta.byExitType ?? []).find((e) => e.signal === "timeout");
  const nonTpSlCount = totalTrades - tpCount - slCount;
  const nonTpSlPct = (nonTpSlCount / totalTrades) * 100;

  if (nonTpSlPct > 60) {
    warnings.push(
      `⚠️ EXIT STRUCTURE: ${Math.floor(nonTpSlPct)}% of trades exit via timeout/trail (not TP or SL). ` +
      `Only ${tpCount} TPs hit out of ${totalTrades} trades. ` +
      `Possible fixes: increase timeout bars, widen TP target, or improve entry timing.`,
    );
  }

  if (tpCount > 0 && slCount > 0) {
    const tpPnl = tpExits.reduce((sum, e) => sum + e.pnl, 0);
    const slPnl = slExits.reduce((sum, e) => sum + e.pnl, 0);
    if (Math.abs(slPnl) > tpPnl * 2) {
      warnings.push(
        `⚠️ SL DAMAGE: ${slCount} stop losses cost ${slPnl.toFixed(2)} USD while ${tpCount} TPs earned only ${tpPnl.toFixed(2)} USD. ` +
        `SL exits destroy more value than TPs create. Consider widening stops or improving entry quality.`,
      );
    }
  }

  // 2. Day-of-week analysis: flag catastrophic days
  if (ta.byDayOfWeek) {
    const days = Object.entries(ta.byDayOfWeek).sort((a, b) => a[1].pnl - b[1].pnl);
    const worst = days[0];
    if (worst) {
      const totalPnl = days.reduce((sum, [, s]) => sum + s.pnl, 0);
      if (totalPnl < 0 && worst[1].pnl < totalPnl * 0.4 && worst[1].count >= 5) {
        warnings.push(
          `⚠️ DAY ANOMALY: ${worst[0]} accounts for ${Math.floor((worst[1].pnl / totalPnl) * 100)}% of total losses ` +
          `(${worst[1].pnl.toFixed(2)} USD on ${worst[1].count} trades). ` +
          `Investigate what's different about ${worst[0]} entries — use volatility/volume conditions, NOT day-of-week filters.`,
        );
      }
    }
  }

  if (!warnings.length) return "";
  return "\n### Structural Diagnostics\n" + warnings.join("\n") + "\n";
}

function buildRollbackSection(reason?: string): string {
  if (!reason) return "";
  return `\n> ⚠ LAST ITERATION ROLLED BACK: ${reason}\n> Focus on avoiding the same mistake.\n\n`;
}

function buildWalkForwardSection(
  wf?: WalkForward | null,
  mc?: { wrWarnMax: number | null; wrRejectMax: number | null } | null,
): string {
  if (!wf) return "";
  const lines = ["\n## WALK-FORWARD VALIDATION (train 70% / test 30%)"];
  lines.push(`trainPF=${wf.trainPF?.toFixed(2) ?? "?"} | testPF=${wf.testPF?.toFixed(2) ?? "?"} | pfRatio=${wf.pfRatio?.toFixed(2) ?? "?"} | overfitFlag=${wf.overfitFlag}`);
  const ratio = wf.pfRatio ?? 0;
  if (ratio >= 0.85) {
    lines.push("-> pfRatio 0.85+ — excellent generalization. Strategy is robust.");
  } else if (ratio >= 0.70) {
    lines.push("-> pfRatio 0.70-0.84 — good. Minor complexity increases may still be safe.");
  } else if (ratio >= 0.60) {
    lines.push("-> pfRatio 0.60-0.69 — borderline. Any further complexity risks tipping into overfit.");
  } else {
    lines.push("-> pfRatio < 0.60 — currently overfitting. Reduce model complexity, simplify conditions, or widen parameter ranges.");
    lines.push("  Prefer changes that improve TEST PF. Do NOT add new indicators or conditions.");
  }
  // trainPF < 1.0 warning
  if (wf.trainPF !== null && wf.trainPF !== undefined && wf.trainPF < 1.0) {
    lines.push(`-> trainPF < 1.00 — strategy barely profitable on 70% of data. All profit comes from the test window.`);
  }
  return lines.join("\n") + "\n";
}

function buildModuleCriteriaSection(
  mc: { minTrades: number; minPF: number; maxDD: number; minWR: number | null; minAvgR: number | null; minPfRatio: number; wrWarnMax?: number | null; wrRejectMax?: number | null },
  moduleId: string,
): string {
  const lines = [`## MODULE ACCEPTANCE CRITERIA (${moduleId})`];
  lines.push(`- Trades >= ${mc.minTrades}`);
  lines.push(`- PF >= ${mc.minPF}`);
  lines.push(`- DD <= ${mc.maxDD}%`);
  if (mc.minWR !== null) lines.push(`- WR >= ${mc.minWR}% [mandatory]`);
  if (mc.minAvgR !== null) lines.push(`- avgR >= ${mc.minAvgR}R`);
  lines.push(`- pfRatio >= ${mc.minPfRatio} (walk-forward)`);
  if (mc.wrWarnMax !== null && mc.wrWarnMax !== undefined) {
    lines.push(`- Expected WR range: WR > ${mc.wrWarnMax}% triggers warning, > ${mc.wrRejectMax}% triggers rejection`);
  }
  return lines.join("\n") + "\n\n";
}

function buildStretchSection(moduleId: string): string {
  const mc = MODULE_CRITERIA[moduleId];
  if (!mc) return "";
  const stretch = computeStretchCriteria(moduleId);
  const degradPct = (mc.expectedDegradation * 100).toFixed(0);
  const lines = [`## DEPLOYMENT TARGET (estimated live profitability)`];
  lines.push(`KB Floor: PF >= ${mc.minPF} (minimum to not be rejected)`);
  lines.push(`Stretch:  PF >= ${stretch.stretchPF} (to survive ~${degradPct}% backtest-to-live degradation)`);
  if (stretch.stretchAvgR !== null) {
    lines.push(`Stretch:  avgR >= ${stretch.stretchAvgR}R`);
  }
  lines.push(`-> The loop continues until stretch targets are met or max iterations reached.`);
  lines.push(`-> A strategy at PF=${mc.minPF} is expected to LOSE money live. Aim for PF >= ${stretch.stretchPF}.`);
  return lines.join("\n") + "\n\n";
}

function buildFailedRestructuresSection(failures?: RestructureFailure[]): string {
  if (!failures || failures.length === 0) return "";
  const lines = [
    "\n## FAILED RESTRUCTURE ATTEMPTS THIS SESSION",
    "The following restructure attempts were ROLLED BACK because they degraded performance:",
  ];
  for (const f of failures) {
    const diag = f.diagnosis ? ` | ${f.diagnosis}` : "";
    lines.push(`  - globalIter ${f.globalIter}: ${f.trades} trades, PF=${f.pf.toFixed(2)}, Score=${f.score.toFixed(1)}${diag}`);
  }
  lines.push("");
  lines.push("DO NOT repeat the same structural approach. Each attempt above produced catastrophically few trades.");
  lines.push("Try a fundamentally different entry/exit structure, or make a LESS aggressive modification to the existing strategy.");
  lines.push("");
  return lines.join("\n");
}

function buildFilterSimsSection(tradeAnalysis: TradeAnalysis | null): string {
  const sims = tradeAnalysis?.filterSimulations;
  if (!sims || !sims.totalTrades) return "";

  const lines = [`## FILTER SIMULATIONS (estimated impact — informational only)`];
  lines.push(`Base: ${sims.totalTrades} trades | Total PnL ${sims.totalPnl >= 0 ? "+" : ""}${sims.totalPnl} USD`);
  lines.push(`NOTE: Do NOT implement hour or day-of-week filters based on this data. Use adaptive volume/volatility filters instead.\n`);

  const fmt = (h: { tradesAfter: number; tradesRemoved: number; pnlDelta: number; pnlAfter: number }) =>
    `  tradesAfter=${h.tradesAfter} (−${h.tradesRemoved}), ΔPnL=${h.pnlDelta >= 0 ? "+" : ""}${h.pnlDelta} → total est. ${h.pnlAfter >= 0 ? "+" : ""}${h.pnlAfter} USD`;

  const improvingHours = sims.byHour.filter((h) => h.pnlDelta > 0).slice(0, 5);
  if (improvingHours.length) {
    lines.push("Block hour — would IMPROVE PnL (diagnostic only, do NOT implement as filters):");
    for (const h of improvingHours)
      lines.push(`  ${String(h.hour).padStart(2, "0")}h UTC: ${fmt(h)}`);
  }

  const sl = sims.removeAllSL;
  if (sl.tradesRemoved > 0) {
    lines.push(`Upper bound (remove all SL): ΔPnL=${sl.pnlDelta >= 0 ? "+" : ""}${sl.pnlDelta} USD`);
  }

  return lines.join("\n") + "\n\n";
}

function buildOverfitSection(
  paramHistory: ParameterHistory | null,
  tradeAnalysis: TradeAnalysis | null,
  minPfRatio: number,
  metrics: Metrics,
  moduleId: string,
): string {
  const warnings: string[] = [];

  // Directional bias
  if (tradeAnalysis?.byDirection) {
    for (const [dir, stats] of Object.entries(tradeAnalysis.byDirection)) {
      if (stats.count < 10) continue;
      const pf = stats.profitFactor ?? 0;
      if (pf < 0.5) {
        warnings.push(`DIRECTIONAL BIAS: ${dir} PF=${pf}. STRUCTURAL — consider directional filter or disable ${dir} side.`);
      }
    }
  }

  // PnL concentration (if top 3 trades account for > 60% of total PnL)
  if (tradeAnalysis && tradeAnalysis.best3TradesPnl.length >= 3) {
    const totalPnl = tradeAnalysis.byDirection
      ? Object.values(tradeAnalysis.byDirection).reduce((sum, d) => sum + d.pnl, 0)
      : 0;
    if (totalPnl > 0) {
      const top3Pnl = tradeAnalysis.best3TradesPnl.reduce((sum, v) => sum + v, 0);
      const concentration = top3Pnl / totalPnl;
      if (concentration > 0.6) {
        warnings.push(
          `PNL CONCENTRATION: top 3 trades = ${(concentration * 100).toFixed(0)}% of total PnL. ` +
          `Strategy may be fragile — edge depends on outliers, not consistent expectancy.`,
        );
      }
    }
  }

  // Session concentration
  if (tradeAnalysis?.bySession) {
    const sessions = Object.entries(tradeAnalysis.bySession);
    const totalTrades = sessions.reduce((sum, [, s]) => sum + s.count, 0);
    for (const [name, stats] of sessions) {
      if (totalTrades > 20 && stats.count / totalTrades > 0.7) {
        warnings.push(
          `SESSION CONCENTRATION: ${name} has ${stats.count}/${totalTrades} trades (${((stats.count / totalTrades) * 100).toFixed(0)}%). ` +
          `Edge may be session-specific — verify it holds across sessions.`,
        );
      }
    }
  }

  // Walk-forward degradation hint
  if (paramHistory?.iterations?.length) {
    const lastIters = paramHistory.iterations.slice(-5);
    const pfValues = lastIters
      .map((i) => i.after?.pf)
      .filter((v): v is number => v !== undefined);
    if (pfValues.length >= 3) {
      const trend = pfValues[pfValues.length - 1]! - pfValues[0]!;
      if (trend < -0.3) {
        warnings.push(
          `PF DECLINING: PF dropped ${Math.abs(trend).toFixed(2)} over last ${pfValues.length} iterations. ` +
          `Possible overfitting to recent data. pfRatio target: >= ${minPfRatio}.`,
        );
      }
    }
  }

  // KB §13.3 red flags
  if ((metrics.profitFactor ?? 0) > 3.0) {
    warnings.push(
      `OVERFIT SIGNAL: PF=${metrics.profitFactor?.toFixed(2)} > 3.0. ` +
      `Extremely high PF in crypto is suspicious — verify walk-forward pfRatio.`,
    );
  }
  if (metrics.maxDrawdownPct != null && Math.abs(metrics.maxDrawdownPct) < 1) {
    warnings.push(
      `OVERFIT SIGNAL: DD=${Math.abs(metrics.maxDrawdownPct).toFixed(1)}% < 1%. ` +
      `Real crypto strategies have drawdowns — suspiciously low DD suggests curve fitting.`,
    );
  }
  if ((metrics.winRate ?? 0) > 80) {
    warnings.push(
      `OVERFIT SIGNAL: WR=${metrics.winRate?.toFixed(1)}% > 80%. ` +
      `Investigate look-ahead bias or excessive curve fitting.`,
    );
  }

  // Archetype WR drift: WR exceeds expected range for this module
  const mcForWr = MODULE_CRITERIA[moduleId];
  if (mcForWr?.wrWarnMax !== null && mcForWr?.wrWarnMax !== undefined && (metrics.winRate ?? 0) > mcForWr.wrWarnMax) {
    const wr = metrics.winRate!;
    const pf = metrics.profitFactor ?? 0;
    const moduleName = moduleId === "M1" ? "breakout" : moduleId === "M2" ? "mean-reversion" : moduleId === "M3" ? "pullback" : "trend-following";
    const pfDiag = pf < 1.5
      ? ` Combined with PF=${pf.toFixed(2)}, this confirms TPs are too tight — high WR but poor R:R.`
      : "";
    warnings.push(
      `ARCHETYPE DRIFT WARNING: WR=${wr.toFixed(1)}% exceeds expected range for ${moduleName} (warn>${mcForWr.wrWarnMax}%, reject>${mcForWr.wrRejectMax}%).${pfDiag} ` +
      `Widen TPs to let winners run (improves R:R even if WR drops). ` +
      `If WR stays high despite wider TPs, entry logic may be capturing mean-reversion setups instead of breakouts.`,
    );
  }

  // KB §13.3: "Score increasing but trades decreasing drastically → filtering until it finds noise"
  if (paramHistory?.iterations?.length && paramHistory.iterations.length >= 3) {
    const lastIters = paramHistory.iterations.slice(-5);
    const tradeValues = lastIters
      .map((i) => i.after?.trades)
      .filter((v): v is number => v !== undefined);
    if (tradeValues.length >= 3) {
      const first = tradeValues[0]!;
      const last = tradeValues[tradeValues.length - 1]!;
      if (first > 0 && last < first * 0.5) {
        warnings.push(
          `TRADE EROSION: trades dropped from ${first} to ${last} over last ${tradeValues.length} iterations. ` +
          `Strategy may be filtering to noise — fewer trades + better score = classic overfit.`,
        );
      }
    }
  }

  // KB §13.2: Module-specific session sanity checks
  if (tradeAnalysis?.bySession) {
    const sessions = tradeAnalysis.bySession;
    if (sessions.Asia && sessions.London && sessions.NY) {
      const pfs = [
        { name: "Asia", pf: sessions.Asia.profitFactor, count: sessions.Asia.count },
        { name: "London", pf: sessions.London.profitFactor, count: sessions.London.count },
        { name: "NY", pf: sessions.NY.profitFactor, count: sessions.NY.count },
      ].filter((s) => s.count >= 5);

      if (pfs.length >= 2) {
        const maxPf = Math.max(...pfs.map((s) => s.pf));
        const minPf = Math.min(...pfs.map((s) => s.pf));

        if (moduleId === "M2") {
          // KB §13.2: MR operates 24/7, PF should be consistent across sessions
          if (maxPf > 0 && minPf < maxPf * 0.3) {
            const best = pfs.find((s) => s.pf === maxPf)!;
            const worst = pfs.find((s) => s.pf === minPf)!;
            warnings.push(
              `MR SESSION INCONSISTENCY (KB §13.2): ${best.name} PF=${best.pf} vs ${worst.name} PF=${worst.pf}. ` +
              `MR should be consistent 24/7 — PF concentrated in one session = fragile edge.`,
            );
          }
        } else if (moduleId === "M1") {
          // KB §13.2: Breakout high PF in London/NY = correct; high PF in Asia = suspicious
          const asiaPf = pfs.find((s) => s.name === "Asia");
          const londonPf = pfs.find((s) => s.name === "London");
          const nyPf = pfs.find((s) => s.name === "NY");
          if (asiaPf && (londonPf || nyPf)) {
            const westPf = Math.max(londonPf?.pf ?? 0, nyPf?.pf ?? 0);
            if (asiaPf.pf > westPf * 1.5 && asiaPf.pf > 1.0) {
              warnings.push(
                `BREAKOUT SESSION ANOMALY (KB §13.2): Asia PF=${asiaPf.pf} > London/NY PF=${westPf.toFixed(2)}. ` +
                `Breakout edge in Asia (low volatility) is suspicious — expect higher PF in London/NY.`,
              );
            }
          }
        } else {
          // Generic session imbalance for M3/M4
          if (maxPf > 0 && minPf < maxPf * 0.3) {
            const best = pfs.find((s) => s.pf === maxPf)!;
            const worst = pfs.find((s) => s.pf === minPf)!;
            warnings.push(
              `SESSION IMBALANCE: ${best.name} PF=${best.pf} vs ${worst.name} PF=${worst.pf}. ` +
              `Large session disparity — edge may be fragile or session-specific.`,
            );
          }
        }
      }
    }
  }

  if (!warnings.length) return "";
  return "## ROBUSTNESS DIAGNOSTIC\n" + warnings.join("\n") + "\n\n";
}

function buildExploredSpaceSection(
  paramHistory: ParameterHistory | null,
  globalIter: number, iter: number, maxIter: number,
): string {
  if (!paramHistory) return "";
  const lines = ["## EXPLORED SPACE (do not repeat)"];

  const ranges = paramHistory.exploredRanges ?? {};
  const rangeEntries = Object.entries(ranges).filter(([, vals]) => Array.isArray(vals) && vals.length > 0);
  if (rangeEntries.length) {
    for (const [param, values] of rangeEntries) {
      lines.push(`${param}: tested [${(values as unknown[]).join(", ")}]`);
    }
  }

  const neverWorked = paramHistory.neverWorked ?? [];
  if (neverWorked.length) {
    lines.push("\nNever worked:");
    for (const item of neverWorked) {
      const label = typeof item === "string"
        ? item
        : `${item.param}=${item.value} [${item.reason ?? "?"}]`;
      lines.push(`- ${label}`);
    }
  }

  lines.push(`\nGlobal iteration: ${globalIter} (loop iter ${iter}/${maxIter})`);
  if (lines.length <= 2) return "";
  return lines.join("\n") + "\n\n";
}

function buildPendingHypothesesSection(paramHistory: ParameterHistory | null): string {
  if (!paramHistory) return "";
  const pending = (paramHistory.pendingHypotheses ?? []).filter((h) => !h.expired);
  if (!pending.length) return "";

  const lines = ["## PENDING HYPOTHESES FROM PREVIOUS ITERATIONS"];
  for (const h of pending) {
    const cond = h.condition ? ` (condition: ${h.condition})` : "";
    lines.push(`- iter ${h.iter} rank#${h.rank}: ${h.hypothesis}${cond}`);
  }
  return lines.join("\n") + "\n\n";
}

function buildApproachHistorySection(paramHistory: ParameterHistory | null): string {
  if (!paramHistory?.approaches?.length) return "";
  const lines = ["## APPROACH HISTORY"];
  for (const a of paramHistory.approaches) {
    const verdict = a.verdict === "exhausted" ? "EXHAUSTED"
      : a.verdict === "active" ? "ACTIVE" : "PROMISING";
    lines.push(`- #${a.id} "${a.name}" iter ${a.startIter}-${a.endIter} | bestScore=${a.bestScore} | ${verdict}`);
  }
  return lines.join("\n") + "\n\n";
}

/** Heuristic param→metric effect map based on common param names. */
function inferParamEffect(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("stop") || n.includes("atr") && n.includes("mult")) return "↑ wider stop, fewer SL hits, more DD | ↓ tighter stop, more SL | → DD, avgR";
  if (n.includes("dc") && n.includes("slow") || n.includes("lookback") && !n.includes("fast")) return "↑ fewer/bigger breakouts | ↓ more/smaller trades | → trade frequency, DD";
  if (n.includes("dc") && n.includes("fast") || n.includes("trail")) return "↑ slower trail exit | ↓ faster trail exit | → avgR, hold duration";
  if (n.includes("adx") || n.includes("threshold") || n.includes("filter")) return "↑ stricter filter, fewer trades | ↓ more trades allowed | → entry quality, trade count";
  if (n.includes("timeout") || n.includes("bars")) return "↑ longer hold time | ↓ quicker exit | → WR, avgR";
  if (n.includes("rsi")) return "↑/↓ changes entry sensitivity | → entry timing, WR";
  if (n.includes("kc") || n.includes("keltner") || n.includes("mult")) return "↑ wider channel, fewer entries | ↓ tighter channel, more entries | → trade count, WR";
  if (n.includes("tp") || n.includes("target") || n.includes("profit")) return "↑ wider target, fewer wins but bigger | ↓ tighter target, more wins | → WR, avgR";
  return "";
}

function buildCoreParamsSection(
  coreParams: CoreParameterDef[] | undefined,
  exploredRanges: Record<string, unknown[]> | undefined,
): string {
  if (!coreParams?.length) return "";
  const lines = ["## CORE PARAMETERS (STRICT SEQUENTIAL ORDER)"];
  let foundIncomplete = false;

  for (const cp of coreParams) {
    const expected: number[] = [];
    for (let v = cp.min; v <= cp.max + cp.step * 0.001; v += cp.step) {
      expected.push(+v.toFixed(4));
    }

    const tested = (exploredRanges?.[cp.name] ?? []) as number[];
    const testedSet = new Set(tested.map((v) => +Number(v).toFixed(4)));
    const remaining = expected.filter((v) => !testedSet.has(v));
    const status = remaining.length === 0
      ? "COMPLETE"
      : `${tested.length}/${expected.length} tested`;

    const effect = inferParamEffect(cp.name);
    const effectStr = effect ? ` | ${effect}` : "";

    if (remaining.length > 0 && !foundIncomplete) {
      foundIncomplete = true;
      lines.push(`${cp.name} [${cp.min}-${cp.max}, step ${cp.step}]: ${status}, remaining: [${remaining.join(", ")}] → NEXT${effectStr}`);
    } else if (remaining.length > 0) {
      lines.push(`${cp.name} [${cp.min}-${cp.max}, step ${cp.step}]: ${status} [BLOCKED]${effectStr}`);
    } else {
      lines.push(`${cp.name} [${cp.min}-${cp.max}, step ${cp.step}]: ${status}${effectStr}`);
    }
  }

  return lines.join("\n") + "\n\n";
}

function buildDesignChecklistSection(checklist: string[] | undefined, globalIter: number): string {
  if (!checklist?.length || globalIter !== 1) return "";
  const lines = ["## PRE-CHECK: validate strategy implements ALL components"];
  for (const item of checklist) lines.push(`[ ] ${item}`);
  return lines.join("\n") + "\n\n";
}

// Only run main() when executed directly
if (isMainModule(import.meta.url)) {
  console.error("This module is imported by the orchestrator, not run directly.");
  process.exit(1);
}