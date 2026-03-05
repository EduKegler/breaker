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

import type { Metrics, TradeAnalysis, StrategyParam, SessionName } from "@breaker/backtest";
import type { ResolvedCriteria, CoreParameterDef } from "../types/config.js";
import type { ParameterHistory, ApproachRecord } from "../types/parameter-history.js";
import type { ModuleContext } from "../lib/build-module-context.js";
import { MODULE_CRITERIA } from "../lib/build-module-context.js";
import { safeJsonParse } from "../lib/safe-json.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function buildOptimizePrompt(opts: BuildPromptOptions): string {
  const {
    metrics, tradeAnalysis, strategySourcePath, strategyParams, paramOverrides,
    criteria, asset, moduleContext, phase, iter, maxIter, globalIter,
    paramHistoryPath, artifactsDir, researchBriefPath,
  } = opts;

  // Use KB-aligned criteria for this module, fallback to config
  const mc = MODULE_CRITERIA[moduleContext.moduleId] ?? {
    minTrades: criteria.minTrades ?? 50,
    minPF: criteria.minPF ?? 1.3,
    maxDD: criteria.maxDD ?? 10,
    minWR: criteria.minWR ?? null,
    minAvgR: criteria.minAvgR ?? 0.15,
    minPfRatio: 0.6,
  };

  // Format metrics
  const pnlStr = metrics.totalPnl !== null ? `${metrics.totalPnl.toFixed(2)} USD` : "N/A";
  const tradesStr = metrics.numTrades !== null ? String(metrics.numTrades) : "N/A";
  const pfStr = metrics.profitFactor !== null ? metrics.profitFactor.toFixed(2) : "N/A";
  const ddStr = metrics.maxDrawdownPct !== null ? `${metrics.maxDrawdownPct.toFixed(1)}%` : "N/A";
  const wrStr = metrics.winRate !== null ? `${metrics.winRate.toFixed(1)}%` : "N/A";
  const avgRStr = metrics.avgR !== null ? `${metrics.avgR.toFixed(3)}R` : "N/A";

  // Unmet criteria — module-specific
  const unmetCriteria = buildUnmetCriteria(metrics, mc, pnlStr, tradesStr, pfStr, ddStr, wrStr, avgRStr);

  // Strategy params section
  const paramsSection = buildStrategyParamsSection(strategyParams, paramOverrides, moduleContext.varCap);

  // Trade analysis
  const tradeAnalysisSection = tradeAnalysis ? buildTradeAnalysisSection(tradeAnalysis) : "";

  // Parameter history
  const paramHistorySchema = z.object({
    iterations: z.array(z.object({}).passthrough()),
    neverWorked: z.array(z.unknown()),
    exploredRanges: z.record(z.string(), z.array(z.unknown())),
    pendingHypotheses: z.array(z.object({}).passthrough()),
    approaches: z.array(z.object({}).passthrough()).optional(),
    researchLog: z.array(z.object({}).passthrough()).optional(),
    currentPhase: z.string().optional(),
    phaseStartIter: z.number().optional(),
  });

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
  const overfitSection = buildOverfitSection(paramHistory, tradeAnalysis, mc.minPfRatio);

  // Research brief — updated schema matching conduct-research.ts
  const researchSection = buildResearchSection(researchBriefPath);

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
    moduleContext,
  );

  return `TypeScript strategy optimization loop — iteration ${iter}/${maxIter}.
${phaseHeader}

## CONTEXT
- Asset: ${asset} | Module: ${moduleContext.moduleName} (${moduleContext.moduleId})
- Strategy profile: \`${moduleContext.profile}\`
- Signal TF: ${moduleContext.signalTF} | Regime TF: ${moduleContext.regimeTF}
- Strategy source: \`${strategySourcePath}\`
- Backtest engine: @breaker/backtest (in-process, ~2s per iteration)
- Objective: optimize for Hyperliquid perps

${moduleContextBlock}
## STOPPING CRITERIA (${moduleContext.moduleId})
${moduleContext.stoppingCriteria}

## UNMET CRITERIA
${unmetCriteria.length ? unmetCriteria.join("\n") : "All criteria met!"}

## LAST BACKTEST METRICS
PnL: ${pnlStr} | Trades: ${tradesStr} | PF: ${pfStr} | DD: ${ddStr} | WR: ${wrStr} | AvgR: ${avgRStr}

${designChecklistSection}${paramsSection}
${kbConstraintsBlock}${overfitSection}${tradeAnalysisSection}
${filterSimsSection}${exploredSpaceSection}${coreParamsSection}${pendingHypothesesSection}${approachHistorySection}${researchSection}
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
  higherTimeframes: Record<string, Candle[]>;
  track(name: string, passed: boolean, value?: number, threshold?: number): boolean;
  indicator(name: string, value: number): void;
}
interface Strategy {
  name: string;
  params: Record<string, StrategyParam>;
  requiredTimeframes: string[];          // MANDATORY — runner loads these HTFs
  requiredWarmup?: Record<string, number>;
  init?(candles: Candle[], htf: Record<string, Candle[]>): void;
  onCandle(ctx: StrategyContext): Signal | null;
  shouldExit(ctx: StrategyContext): { exit: boolean; comment: string } | null; // MANDATORY
  computeLevels(ctx: StrategyContext, direction: "long" | "short"): { stopLoss: number; takeProfits: { price: number; pctOfPosition: number }[] } | null; // MANDATORY
  getExitLevel?(ctx: StrategyContext): number | null;
}
\`\`\`

## OPTIMIZATION RULES
- **1 change per iteration** (refine phase): change ONE param value. Restructure can make larger changes.
- **Variable cap: ${moduleContext.varCap}** — current optimizable params must not exceed this. Adding a param requires dropping another.
- **Core parameters first**: fully sweep core parameter ranges before secondary params.
- **FORBIDDEN: day-of-week filters**. No dayofweek conditions.
- **FORBIDDEN: hour-of-day filters**. Volume confirmation (M1 rule 3) handles low-liquidity periods adaptively.
- **Axis exhaustion**: a core param is only EXHAUSTED when every value in min/max/step has been tested.
- **Directional bias**: if one direction PF < 0.5, diagnosis is STRUCTURAL.
- **Next steps are conditionals**: use format "if [metric X] then [action Y]".
- **FORBIDDEN: category change**. Strategy archetype (${moduleContext.profile}) MUST NOT change without RESTRUCTURE approval.
- **FORBIDDEN: violating fixed rules**. See MODULE FIXED RULES above — these are hard constraints.
- **MANDATORY diagnostics**: every entry condition MUST use \`ctx.track(name, passed, value, threshold)\` and intermediate values MUST use \`ctx.indicator(name, value)\`. Track calls use "L:" or "S:" prefix per direction. Removal is FORBIDDEN — the guardrail will reject the iteration.
- **MANDATORY computeLevels()**: strategy MUST implement \`computeLevels(ctx, direction)\` returning \`{ stopLoss, takeProfits }\`. Used by \`/quick-signal\` for manual signals. Removal is FORBIDDEN.
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
  if ((metrics.maxDrawdownPct ?? 100) > mc.maxDD)
    unmet.push(`- Max Drawdown must be <= ${mc.maxDD}% (current: ${ddStr})`);

  // WR gate: only for modules that require it (M2)
  if (mc.minWR !== null && (metrics.winRate ?? 0) < mc.minWR)
    unmet.push(`- Win Rate must be >= ${mc.minWR}% (current: ${wrStr}) [mandatory for this module]`);

  // avgR gate: only for modules that require it (M1, M3, M4)
  if (mc.minAvgR !== null && (metrics.avgR ?? 0) < mc.minAvgR)
    unmet.push(`- Avg R/trade must be >= ${mc.minAvgR}R (current: ${avgRStr})`);

  return unmet;
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
  moduleContext: ModuleContext,
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
   Do NOT edit \`${paramHistoryPath}\`.`;
  }

  if (phase === "research") {
    return `## TASK (phase: RESEARCH → IMPLEMENT)

A research brief has already been produced by the research stage.
Your job is to IMPLEMENT the best suggested approach from the brief.

0. **Read** the research brief (already loaded in RECENT RESEARCH section above)
1. **Select** the approach with best compliance and expected metrics
2. **Implement** in \`${strategySourcePath}\`:
   - Must comply with ALL fixed rules for ${moduleContext.moduleId}
   - Must stay within ${moduleContext.varCap} var cap
   - Must respect RESTRUCTURE locks (if any)
3. **Run** \`pnpm --filter @breaker/backtest typecheck\` to validate
4. **Write metadata** to \`${metadataPath}\` with scale: "structural"
   Do NOT edit \`${paramHistoryPath}\`.

CRITICAL: Do NOT run WebSearch. Research is already done. Focus on clean implementation.`;
  }

  // restructure
  return `## TASK (phase: RESTRUCTURE)

**CRITICAL**: EDIT \`${strategySourcePath}\`. Apply structural changes.

1. **EDIT** the strategy .ts file — apply structural rewrite
   - Must comply with ALL fixed rules for ${moduleContext.moduleId}
   - Must stay within ${moduleContext.varCap} var cap
   - Respect RESTRUCTURE locks unless explicitly changing architecture
2. **Run** \`pnpm --filter @breaker/backtest typecheck\` to validate
3. **Record** changes
4. **Write metadata** to \`${metadataPath}\` with:
   - scale: "structural"
   - What RESTRUCTURE lock was changed (if any)
   - ruleCompliance check
   Do NOT edit \`${paramHistoryPath}\`.`;
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
  return `## TRADE ANALYSIS
By exit type:
${(ta.byExitType ?? [])
  .map((e) => `  ${e.signal.padEnd(18)}: ${String(e.count).padStart(3)}t | WR=${String(e.winRate).padStart(5)}% | PnL=${e.pnl >= 0 ? "+" : ""}${e.pnl} USD`)
  .join("\n") || "  (no data)"}

Average duration: winners=${ta.avgBarsWinners ?? "?"} bars | losers=${ta.avgBarsLosers ?? "?"} bars

By direction:
${Object.entries(ta.byDirection)
  .map(([d, v]) => `  ${d}: ${v.count}t, PnL=${v.pnl >= 0 ? "+" : ""}${v.pnl}, WR=${v.winRate}%, PF=${v.profitFactor ?? "?"}`)
  .join("\n")}

${ta.bySession ? `By session:\n${(["Asia", "London", "NY", "Off-peak"] as SessionName[]).map((s) => {
  const ss = ta.bySession![s];
  return `  ${s.padEnd(9)}: ${String(ss.count).padStart(3)}t | WR=${String(ss.winRate).padStart(5)}% | PF=${String(ss.profitFactor).padStart(5)} | PnL=${ss.pnl >= 0 ? "+" : ""}${ss.pnl} USD`;
}).join("\n")}` : ""}
Best trades: ${ta.best3TradesPnl.join(", ")} USD | Worst: ${ta.worst3TradesPnl.join(", ")} USD
`;
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

    if (remaining.length > 0 && !foundIncomplete) {
      foundIncomplete = true;
      lines.push(`${cp.name}: ${status}, remaining: [${remaining.join(", ")}] → NEXT`);
    } else if (remaining.length > 0) {
      lines.push(`${cp.name}: ${status} [BLOCKED]`);
    } else {
      lines.push(`${cp.name}: ${status}`);
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