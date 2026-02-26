#!/usr/bin/env node
/**
 * build-optimize-prompt-ts.ts
 *
 * Generates the full prompt for the B.R.E.A.K.E.R. TypeScript strategy optimization.
 * Replaces Pine-specific build-optimize-prompt.ts.
 *
 * Exported as a function for use by the orchestrator (no subprocess needed).
 */

import fs from "node:fs";
import { z } from "zod";

import type { Metrics, TradeAnalysis, StrategyParam, SessionName } from "@trading/backtest";
import type { ResolvedCriteria, CoreParameterDef } from "../types/config.js";
import type { ParameterHistory, ApproachRecord } from "../types/parameter-history.js";
import { safeJsonParse } from "../lib/safe-json.js";

export interface BuildPromptOptions {
  metrics: Metrics;
  tradeAnalysis: TradeAnalysis | null;
  strategySourcePath: string;
  strategyParams: Record<string, StrategyParam>;
  paramOverrides: Record<string, number>;
  criteria: ResolvedCriteria;
  asset: string;
  strategy: string;
  phase: "refine" | "research" | "restructure";
  iter: number;
  maxIter: number;
  globalIter: number;
  paramHistoryPath: string;
  artifactsDir: string;
  researchBriefPath?: string;
}

export function buildOptimizePrompt(opts: BuildPromptOptions): string {
  const {
    metrics, tradeAnalysis, strategySourcePath, strategyParams, paramOverrides,
    criteria, asset, strategy, phase, iter, maxIter, globalIter,
    paramHistoryPath, artifactsDir, researchBriefPath,
  } = opts;

  const MIN_TRADES = criteria.minTrades ?? 150;
  const MIN_PF = criteria.minPF ?? 1.25;
  const MAX_DD = criteria.maxDD ?? 12;
  const MIN_WR = criteria.minWR ?? 20;
  const MIN_AVG_R = criteria.minAvgR ?? 0.15;

  const pnlStr = metrics.totalPnl !== null ? `${metrics.totalPnl.toFixed(2)} USD` : "N/A";
  const tradesStr = metrics.numTrades !== null ? String(metrics.numTrades) : "N/A";
  const pfStr = metrics.profitFactor !== null ? metrics.profitFactor.toFixed(2) : "N/A";
  const ddStr = metrics.maxDrawdownPct !== null ? `${metrics.maxDrawdownPct.toFixed(1)}%` : "N/A";
  const wrStr = metrics.winRate !== null ? `${metrics.winRate.toFixed(1)}%` : "N/A";
  const avgRStr = metrics.avgR !== null ? `${metrics.avgR.toFixed(3)}R` : "N/A";

  // Unmet criteria
  const unmetCriteria: string[] = [];
  if ((metrics.totalPnl ?? 0) <= 0) unmetCriteria.push(`- Total P&L must be > 0 USD (current: ${pnlStr})`);
  if ((metrics.numTrades ?? 0) < MIN_TRADES) unmetCriteria.push(`- Trade count must be >= ${MIN_TRADES} (current: ${tradesStr})`);
  if ((metrics.profitFactor ?? 0) < MIN_PF) unmetCriteria.push(`- Profit Factor must be > ${MIN_PF} (current: ${pfStr})`);
  if ((metrics.maxDrawdownPct ?? 100) > MAX_DD) unmetCriteria.push(`- Max Drawdown must be < ${MAX_DD}% (current: ${ddStr})`);
  if ((metrics.winRate ?? 0) < MIN_WR) unmetCriteria.push(`- Win Rate must be >= ${MIN_WR}% (current: ${wrStr})`);
  if ((metrics.avgR ?? 0) < MIN_AVG_R) unmetCriteria.push(`- Avg R/trade must be >= ${MIN_AVG_R}R (current: ${avgRStr})`);

  // Strategy params section
  const paramsSection = buildStrategyParamsSection(strategyParams, paramOverrides);

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
    paramHistory = safeJsonParse(fs.readFileSync(paramHistoryPath, "utf8"), { schema: paramHistorySchema }) as unknown as ParameterHistory;
  } catch { /* File doesn't exist yet */ }

  const exploredSpaceSection = buildExploredSpaceSection(paramHistory, globalIter, iter, maxIter);
  const pendingHypothesesSection = buildPendingHypothesesSection(paramHistory);
  const approachHistorySection = buildApproachHistorySection(paramHistory);
  const coreParamsSection = buildCoreParamsSection(criteria.coreParameters, paramHistory?.exploredRanges as Record<string, unknown[]> | undefined);
  const designChecklistSection = buildDesignChecklistSection(criteria.designChecklist, globalIter);
  const filterSimsSection = buildFilterSimsSection(tradeAnalysis);
  const overfitSection = buildOverfitSection(paramHistory, tradeAnalysis);

  // Research brief (Claude-written, use repair)
  const researchBriefSchema = z.object({
    suggestedApproaches: z.array(z.object({
      name: z.string(),
      indicators: z.array(z.string()),
      entryLogic: z.string(),
      rationale: z.string(),
    })).default([]),
  }).passthrough();

  let researchSection = "";
  if (researchBriefPath) {
    try {
      const brief = safeJsonParse(fs.readFileSync(researchBriefPath, "utf8"), { repair: true, schema: researchBriefSchema });
      const approaches = (brief.suggestedApproaches ?? [])
        .map((a) =>
          `- **${a.name}**: ${a.indicators.join(", ")} — ${a.entryLogic} (${a.rationale})`,
        ).join("\n");
      researchSection = `## RECENT RESEARCH (research phase results)\n${approaches}\n\n`;
    } catch { /* ignore */ }
  }

  const metadataPath = `${artifactsDir}/iter${globalIter}-metadata.json`;

  const phaseHeader = phase === "refine"
    ? `Current phase: REFINE (tuning existing parameters)`
    : phase === "research"
      ? `Current phase: RESEARCH (search alternatives)`
      : `Current phase: RESTRUCTURE (implement structural changes to strategy .ts)`;

  // Phase-specific task
  const phaseTask = buildPhaseTask(phase, strategySourcePath, metadataPath, paramHistoryPath, globalIter, iter, maxIter, pnlStr, tradesStr, wrStr, asset);

  return `TypeScript strategy optimization loop — iteration ${iter}/${maxIter}.
${phaseHeader}

## CONTEXT
- Asset: ${asset} | Strategy profile: ${strategy}
- Strategy source: \`${strategySourcePath}\`
- Backtest engine: @trading/backtest (in-process, ~2s per iteration)
- Objective: optimize for Hyperliquid perps

## UNMET CRITERIA
${unmetCriteria.length ? unmetCriteria.join("\n") : "All criteria met!"}

## LAST BACKTEST METRICS
PnL: ${pnlStr} | Trades: ${tradesStr} | PF: ${pfStr} | DD: ${ddStr} | WR: ${wrStr} | AvgR: ${avgRStr}

${designChecklistSection}${paramsSection}
${overfitSection}${tradeAnalysisSection}
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
interface Strategy {
  name: string;
  params: Record<string, StrategyParam>;
  onCandle(ctx: StrategyContext): Signal | null;
  shouldExit?(ctx: StrategyContext): { exit: boolean; comment: string } | null;
  requiredTimeframes?: string[];
}
\`\`\`

## OPTIMIZATION RULES
- **1 change per iteration** (refine phase): change ONE param value. Restructure can make larger changes.
- **Core parameters first**: fully sweep core parameter ranges before secondary params.
- **FORBIDDEN: day-of-week filters**. No dayofweek conditions.
- **Axis exhaustion**: a core param is only EXHAUSTED when every value in min/max/step has been tested.
- **Directional bias**: if one direction PF < 0.5, diagnosis is STRUCTURAL.
- **Next steps are conditionals**: use format "if [metric X] then [action Y]".
- **FORBIDDEN: category change**. Strategy category (${strategy}) MUST NOT change.
`;
}

function buildStrategyParamsSection(params: Record<string, StrategyParam>, overrides: Record<string, number>): string {
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

  lines.push(`\nTotal optimizable params: ${optimizable.length}`);
  return lines.join("\n") + "\n\n";
}

function buildPhaseTask(
  phase: string, strategySourcePath: string, metadataPath: string,
  paramHistoryPath: string, globalIter: number, iter: number, maxIter: number,
  pnlStr: string, tradesStr: string, wrStr: string, asset: string,
): string {
  if (phase === "refine") {
    return `## TASK (phase: REFINE)

0. **DIAGNOSTIC** (REQUIRED):
   - Classify: PARAMETRIC vs STRUCTURAL
   - If STRUCTURAL: recommend "escalate to research" in phaseRecommendation

1. **Check previous prediction**: read "Next steps if fails" from last iteration.
2. **Analyze** — form hypotheses
3. **Rank hypotheses**:
   | # | Hypothesis | Est. ΔTrades | Est. ΔPnL | Confidence | Reversibility |
   Sort by impact. Apply ONLY #1.
4. **Output param change** as JSON to stdout:
\`\`\`json
{ "paramOverrides": { "dcSlow": 55 } }
\`\`\`
   Only change ONE param per iteration in refine phase.
5. **Write metadata** to \`${metadataPath}\`:
\`\`\`json
{
  "changeApplied": { "param": "...", "from": ..., "to": ..., "scale": "parametric", "description": "..." },
  "hypotheses": [{"rank": 1, "hypothesis": "...", "confidence": "High", "applied": true}],
  "diagnostic": { "type": "parametric", "rootCause": "..." },
  "expectedResult": { "metric": "PnL", "direction": "up", "estimate": "+10-15%" },
  "nextSteps": [{"condition": "PnL < 180", "action": "revert change"}]
}
\`\`\`
   Do NOT edit \`${paramHistoryPath}\`.`;
  }

  if (phase === "research") {
    return `## TASK (phase: RESEARCH)

0. **DIAGNOSTIC**: current approach stagnated.
1. **Search** (WebSearch REQUIRED — minimum 2 searches) alternative strategies for ${asset} 15m
2. **Propose** 2-3 alternative approaches
3. **Choose** most promising and implement in \`${strategySourcePath}\`
4. **Write metadata** to \`${metadataPath}\` with scale: "structural"
   Do NOT edit \`${paramHistoryPath}\`.`;
  }

  // restructure
  return `## TASK (phase: RESTRUCTURE)

**CRITICAL**: EDIT \`${strategySourcePath}\`. Apply structural changes.

1. **EDIT** the strategy .ts file — apply structural rewrite
2. **Run** \`pnpm --filter @trading/backtest typecheck\` to validate
3. **Record** changes
4. **Write metadata** to \`${metadataPath}\`
   Do NOT edit \`${paramHistoryPath}\`.`;
}

export function buildTradeAnalysisSection(ta: TradeAnalysis): string {
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

export function buildFilterSimsSection(tradeAnalysis: TradeAnalysis | null): string {
  const sims = tradeAnalysis?.filterSimulations;
  if (!sims || !sims.totalTrades) return "";

  const lines = [`## FILTER SIMULATIONS (estimated impact)`];
  lines.push(`Base: ${sims.totalTrades} trades | Total PnL ${sims.totalPnl >= 0 ? "+" : ""}${sims.totalPnl} USD\n`);

  const fmt = (h: { tradesAfter: number; tradesRemoved: number; pnlDelta: number; pnlAfter: number }) =>
    `  tradesAfter=${h.tradesAfter} (−${h.tradesRemoved}), ΔPnL=${h.pnlDelta >= 0 ? "+" : ""}${h.pnlDelta} → total est. ${h.pnlAfter >= 0 ? "+" : ""}${h.pnlAfter} USD`;

  const improvingHours = sims.byHour.filter((h) => h.pnlDelta > 0).slice(0, 5);
  if (improvingHours.length) {
    lines.push("Block hour — IMPROVES PnL:");
    for (const h of improvingHours)
      lines.push(`  ${String(h.hour).padStart(2, "0")}h UTC: ${fmt(h)}`);
  }

  const sl = sims.removeAllSL;
  if (sl.tradesRemoved > 0) {
    lines.push(`Upper bound (remove all SL): ΔPnL=${sl.pnlDelta >= 0 ? "+" : ""}${sl.pnlDelta} USD`);
  }

  return lines.join("\n") + "\n\n";
}

export function buildOverfitSection(paramHistory: ParameterHistory | null, tradeAnalysis: TradeAnalysis | null): string {
  const warnings: string[] = [];

  if (tradeAnalysis?.byDirection) {
    for (const [dir, stats] of Object.entries(tradeAnalysis.byDirection)) {
      if (stats.count < 10) continue;
      const pf = stats.profitFactor ?? 0;
      if (pf < 0.5) {
        warnings.push(`DIRECTIONAL BIAS: ${dir} PF=${pf}. STRUCTURAL — use directional filter or disable ${dir} side.`);
      }
    }
  }

  if (!warnings.length) return "";
  return "## ROBUSTNESS DIAGNOSTIC\n" + warnings.join("\n") + "\n\n";
}

export function buildExploredSpaceSection(paramHistory: ParameterHistory | null, globalIter: number, iter: number, maxIter: number): string {
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

export function buildPendingHypothesesSection(paramHistory: ParameterHistory | null): string {
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

export function buildApproachHistorySection(paramHistory: ParameterHistory | null): string {
  if (!paramHistory?.approaches?.length) return "";
  const lines = ["## APPROACH HISTORY"];
  for (const a of paramHistory.approaches) {
    const verdict = a.verdict === "exhausted" ? "EXHAUSTED" : a.verdict === "active" ? "ACTIVE" : "PROMISING";
    lines.push(`- #${a.id} "${a.name}" iter ${a.startIter}-${a.endIter} | bestScore=${a.bestScore} | ${verdict}`);
  }
  return lines.join("\n") + "\n\n";
}

export function buildCoreParamsSection(coreParams: CoreParameterDef[] | undefined, exploredRanges: Record<string, unknown[]> | undefined): string {
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
    const status = remaining.length === 0 ? "COMPLETE" : `${tested.length}/${expected.length} tested`;

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

export function buildDesignChecklistSection(checklist: string[] | undefined, globalIter: number): string {
  if (!checklist?.length || globalIter !== 1) return "";
  const lines = ["## PRE-CHECK: validate strategy implements ALL components"];
  for (const item of checklist) lines.push(`[ ] ${item}`);
  return lines.join("\n") + "\n\n";
}

// Only run main() when executed directly
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("build-optimize-prompt-ts.js");

if (isMain) {
  console.error("This module is imported by the orchestrator, not run directly.");
  process.exit(1);
}
