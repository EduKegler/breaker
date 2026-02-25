#!/usr/bin/env node
/**
 * build-optimize-prompt.ts
 *
 * Generates the full prompt for the B.R.E.A.K.E.R. analysis+improvement iteration.
 *
 * Usage:
 *   node dist/automation/build-optimize-prompt.js <path-to-result.json> <iter> <maxIter>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveAssetCriteria } from "../lib/config.js";
import type { BreakerConfig, CoreParameterDef, ResolvedCriteria } from "../types/config.js";
import type { ParseResultsOutput, TradeAnalysis, SessionName } from "../types/parse-results.js";
import type { ParameterHistory, ApproachRecord } from "../types/parameter-history.js";

import { buildStrategyDir } from "../lib/strategy-path.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(__dirname, "../..");
const ASSET = process.env.ASSET || "BTC";
const STRATEGY = process.env.STRATEGY || "breakout";
const STRATEGY_DIR = buildStrategyDir(REPO_ROOT, ASSET, STRATEGY);
const OPT_LOG =
  process.env.OPT_LOG ||
  path.join(STRATEGY_DIR, "optimization-log.md");
const PINE_FILE =
  process.env.PINE_FILE ||
  path.join(STRATEGY_DIR, "strategy.pine");
const PARAM_HISTORY_FILE =
  process.env.PARAM_HISTORY ||
  path.join(STRATEGY_DIR, "parameter-history.json");
const CONFIG_FILE = path.join(REPO_ROOT, "breaker-config.json");

let CONFIG: BreakerConfig;
try {
  CONFIG = loadConfig(CONFIG_FILE);
} catch {
  CONFIG = { criteria: {}, dateRange: "last365", modelRouting: { optimize: "claude-sonnet-4-6", restructure: "claude-opus-4-6", fix: "claude-haiku-4-5-20251001", plan: "claude-opus-4-6" }, assetClasses: {}, strategyProfiles: {}, guardrails: { maxRiskTradeUsd: 25, maxAtrMult: 10, minAtrMult: 1.5, protectedFields: [] }, assets: {}, phases: { refine: { maxIter: 5 }, research: { maxIter: 3 }, restructure: { maxIter: 5 }, maxCycles: 2 }, scoring: { weights: { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 15, sampleConfidence: 15 } }, research: { enabled: true, model: "claude-sonnet-4-6", maxSearchesPerIter: 3, timeoutMs: 180000, allowedDomains: [] } };
}

const ASSET_CLASS = CONFIG.assets[ASSET]?.class ?? "crypto-major";
const CRITERIA = resolveAssetCriteria(CONFIG, ASSET, STRATEGY);
const MIN_TRADES = CRITERIA.minTrades ?? 150;
const MIN_PF = CRITERIA.minPF ?? 1.25;
const MAX_DD = CRITERIA.maxDD ?? 12;
const MIN_WR = CRITERIA.minWR ?? 20;
const MIN_AVG_R = CRITERIA.minAvgR ?? 0.15;

const MAX_FULL_SECTIONS = 1;
const MAX_COMPRESSED_SECTIONS = 3;

export function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Extracts a **Field**: value from a markdown section.
 */
export function extractField(text: string, field: string): string {
  const m = text.match(
    new RegExp(`\\*\\*${field}[^*]*\\*\\*:\\s*(.+?)(?=\\n- \\*\\*|$)`, "s"),
  );
  return m ? m[1].trim().replace(/\n/g, " ").slice(0, 120) : "—";
}

/**
 * Compresses old log sections to 2 lines (changes + next steps).
 * The most recent section is kept intact for maximum context.
 */
export function compressLog(log: string): string {
  const sections = log.split(/(?=\n## Iteration )/);
  const header = sections[0];
  const iterSections = sections.slice(1);

  if (iterSections.length === 0) return log;

  const fullSections = iterSections.slice(-MAX_FULL_SECTIONS);
  const toCompress = iterSections.slice(0, -MAX_FULL_SECTIONS);

  const compressedSrc = toCompress.slice(-MAX_COMPRESSED_SECTIONS);
  const dropped = toCompress.length - compressedSrc.length;

  const droppedNote =
    dropped > 0
      ? `\n> ⚠ ${dropped} very old iteration(s) omitted.\n`
      : "";

  const compressed = compressedSrc.map((sec) => {
    const headerLine =
      sec.match(/^(\n## Iteration [^\n]+)/)?.[1] ?? "\n## Iteration ?";
    const changes = extractField(sec, "Change applied");
    const nextSteps = extractField(sec, "Next steps[^*]*");
    return `${headerLine} [compressed]\n- Changes: ${changes}\n- Avoid/next: ${nextSteps}`;
  });

  return [header, droppedNote, ...compressed, ...fullSections].join("");
}

function parseNamedArgs(): Record<string, string> {
  const named: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.+)$/);
    if (m) named[m[1]] = m[2];
  }
  return named;
}

function main(): void {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const named = parseNamedArgs();
  const resultFilePath = positional[0];
  const iterStr = positional[1];
  const maxIterStr = positional[2];
  const xlsxFile = positional[3];
  const phase = (named["phase"] ?? "refine") as "refine" | "research" | "restructure";
  const researchBriefPath = named["research-brief-path"];

  if (!resultFilePath) {
    process.stderr.write(
      "Usage: node build-optimize-prompt.js <result.json> <iter> <maxIter> [--phase=refine] [--research-brief-path=...]\n",
    );
    process.exit(1);
  }

  let result: ParseResultsOutput;
  try {
    result = JSON.parse(
      fs.readFileSync(resultFilePath, "utf8"),
    ) as ParseResultsOutput;
  } catch (e) {
    process.stderr.write(
      `Error reading/parsing ${resultFilePath}: ${(e as Error).message}\n`,
    );
    process.exit(1);
  }

  const iter = parseInt(iterStr ?? "1", 10);
  const maxIter = parseInt(maxIterStr ?? "10", 10);
  const { metrics, criteria, tradeAnalysis, pineParams } = result;

  const rawLog = readFileOrEmpty(OPT_LOG);
  const compressedLog = rawLog.trim() ? compressLog(rawLog) : "";
  const historySection = compressedLog
    ? `## PREVIOUS ITERATION HISTORY\n\n${compressedLog}\n`
    : `## PREVIOUS ITERATION HISTORY\n\nNo previous iterations recorded.\n`;

  const pnlStr =
    metrics.totalPnl !== null ? `${metrics.totalPnl.toFixed(2)} USD` : "N/A";
  const tradesStr =
    metrics.numTrades !== null ? String(metrics.numTrades) : "N/A";
  const pfStr =
    metrics.profitFactor !== null
      ? metrics.profitFactor.toFixed(2)
      : "N/A";
  const ddStr =
    metrics.maxDrawdownPct !== null
      ? `${metrics.maxDrawdownPct.toFixed(1)}%`
      : "N/A";
  const wrStr =
    metrics.winRate !== null ? `${metrics.winRate.toFixed(1)}%` : "N/A";

  const unmetCriteria: string[] = [];
  if (!criteria.pnlPositive)
    unmetCriteria.push(
      `- Total P&L must be > 0 USD (current: ${pnlStr})`,
    );
  if (!criteria.tradesOk)
    unmetCriteria.push(
      `- Trade count must be >= ${MIN_TRADES} (current: ${tradesStr})`,
    );
  if (!criteria.pfOk)
    unmetCriteria.push(
      `- Profit Factor must be > ${MIN_PF} (current: ${pfStr})`,
    );
  if (!criteria.ddOk)
    unmetCriteria.push(
      `- Max Drawdown must be < ${MAX_DD}% (current: ${ddStr})`,
    );
  if (!criteria.wrOk)
    unmetCriteria.push(
      `- Win Rate must be >= ${MIN_WR}% (current: ${metrics.winRate?.toFixed(1) ?? "N/A"}%)`,
    );
  if (!criteria.avgROk)
    unmetCriteria.push(
      `- Avg R/trade must be >= ${MIN_AVG_R}R (current: ${metrics.avgR?.toFixed(3) ?? "N/A"}R)`,
    );

  const tradeAnalysisSection = tradeAnalysis
    ? buildTradeAnalysisSection(tradeAnalysis)
    : "";

  const pineParamsSection = buildPineParamsSection(pineParams);
  const complexitySection = buildComplexitySection(pineParams);

  let paramHistory: ParameterHistory | null = null;
  try {
    paramHistory = JSON.parse(
      fs.readFileSync(PARAM_HISTORY_FILE, "utf8"),
    ) as ParameterHistory;
  } catch {
    // File doesn't exist yet
  }

  const globalIter = (paramHistory?.iterations ?? []).length + 1;

  // Phase-aware search instruction
  let searchInstruction: string;
  if (phase === "research") {
    searchInstruction = `3. **Search** (WebSearch REQUIRED — minimum 2 searches): search alternative strategies for ${ASSET} 15m, unexplored indicators, entry/exit patterns`;
  } else if (iter <= 2) {
    searchInstruction = `3. **Search** (use WebSearch) strategies for ${ASSET} 15m: risk management, regime filters, entry timing`;
  } else {
    searchInstruction = `3. **Search** (WebSearch optional — use ONLY if hypothesis requires specific external data)`;
  }

  // Load research brief if available
  let researchSection = "";
  if (researchBriefPath) {
    try {
      const brief = JSON.parse(fs.readFileSync(researchBriefPath, "utf8"));
      const approaches = (brief.suggestedApproaches ?? [])
        .map((a: { name: string; indicators: string[]; entryLogic: string; rationale: string }) =>
          `- **${a.name}**: ${a.indicators.join(", ")} — ${a.entryLogic} (${a.rationale})`,
        ).join("\n");
      researchSection = `## RECENT RESEARCH (research phase results)\n${approaches}\n\n`;
    } catch { /* ignore */ }
  }

  // Build approach history section
  const approachHistorySection = buildApproachHistorySection(paramHistory);

  // Build diagnostic instruction
  const diagnosticInstruction = buildDiagnosticInstruction(phase);

  // Phase-specific task header
  const phaseHeader = phase === "refine"
    ? `Current phase: REFINE (tuning existing parameters and filters)`
    : phase === "research"
      ? `Current phase: RESEARCH (search alternatives — WebSearch REQUIRED)`
      : `Current phase: RESTRUCTURE (implement and iterate new approach)`;

  // Metadata output path
  const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.join(REPO_ROOT, "artifacts");
  const metadataPath = path.join(ARTIFACTS_DIR, `iter${globalIter}-metadata.json`);

  const overfitSection = buildOverfitSection(paramHistory, tradeAnalysis);
  const filterSimsSection = buildFilterSimsSection(tradeAnalysis);
  const exploredSpaceSection = buildExploredSpaceSection(
    paramHistory,
    globalIter,
    iter,
    maxIter,
  );
  const pendingHypothesesSection = buildPendingHypothesesSection(
    paramHistory,
  );

  // New sections: core parameters and design checklist
  const coreParamsSection = buildCoreParamsSection(
    CRITERIA.coreParameters,
    paramHistory?.exploredRanges as Record<string, unknown[]> | undefined,
  );
  const designChecklistSection = buildDesignChecklistSection(
    CRITERIA.designChecklist,
    globalIter,
  );

  const pineRules = `## PINE SCRIPT RULES (common errors — use MCP pinescript-syntax-checker to validate)
- Functions using series (ta.*, request.*) must be in GLOBAL scope, not inside if/for
- Line continuation: use parentheses, not backslash
- \`var\` for persistent state across bars; without \`var\` to recalculate every bar
- plot() does not accept bool — use \`condition ? 1 : 0\`
- strategy.entry() requires unique string id; strategy.exit() requires matching from_entry
- Variable declarations (var/varip) are not allowed inside functions`;

  // Phase-specific task section
  let phaseTask: string;
  if (phase === "refine") {
    phaseTask = `## TASK (phase: REFINE)

0. **DIAGNOSTIC** (REQUIRED — before hypotheses):
   - Classify: PARAMETRIC (numeric/filter value tuning solves it) vs STRUCTURAL (entry/exit logic fundamentally inadequate)
   - Identify ROOT CAUSE, not symptom
   - If classified as STRUCTURAL in refine phase: recommend "escalate to research" in phaseRecommendation metadata field

1. **Check previous prediction**: read the "Next steps if fails" from the last iteration in history.
   - If a condition applies, execute that action — it takes priority over new hypotheses.
2. **Analyze** the data above — form hypotheses about the cause of poor results
3. **Validate** hypotheses with trade patterns and FILTER SIMULATIONS when available
${searchInstruction}
4. **Rank hypotheses**: for each candidate, estimate:
   | # | Hypothesis | Est. ΔTrades | Est. ΔPnL | Confidence | Reversibility |
   |---|----------|-------------|-----------|-----------|----------------|
   Confidence: High (>30 trades in pattern) | Medium (10–30) | Low (<10)
   Sort by impact. Apply ONLY #1 (highest priority).
5. **Edit** \`${PINE_FILE}\` — apply change #1 (only ONE per iteration).
   - "Minimum effective change" rule: Parametric → 1 param; Filter → 1 filter; NEVER parameter + structure in same iter.
6. **Record** in \`${OPT_LOG}\` (APPEND):
\`\`\`
## Iteration ${globalIter} (loop ${iter}/${maxIter}, phase: ${phase}) — [current date and time, e.g. 2026-02-25 14:30]
- **Diagnostic**: [PARAMETRIC|STRUCTURAL] — [root cause]
- **Previous prediction vs actual result**: [what was predicted, what happened]
- **Metrics**: PnL=${pnlStr}, Trades=${tradesStr}, WinRate=${wrStr}
- **Ranked hypotheses**:
  | # | Hypothesis | ΔTrades | Est. ΔPnL | Conf. | Action |
  |---|----------|---------|-----------|-------|------|
  | 1 | [APPLIED] ... | ... | ... | High | apply |
  | 2 | ... | ... | ... | Medium | next if #1 fails |
- **Change applied** (only 1): [what was changed and why]
- **Expected result**: [specific metric that should change and by how much]
- **Next steps if fails**: [explicit conditionals: "if X then Y, if Z then W"]
\`\`\`
7. **Write metadata** to \`${metadataPath}\`:
\`\`\`json
{
  "changeApplied": { "param": "...", "from": ..., "to": ..., "scale": "parametric", "description": "..." },
  "hypotheses": [{"rank": 1, "hypothesis": "...", "confidence": "High", "applied": true}, ...],
  "diagnostic": { "type": "parametric", "rootCause": "...", "phaseRecommendation": null },
  "expectedResult": { "metric": "PnL", "direction": "up", "estimate": "+10-15%" },
  "nextSteps": [{"condition": "PnL < 180", "action": "revert atrMult"}]
}
\`\`\`
   If no change (nothing to change), write changeApplied: null.
   Do NOT edit \`${PARAM_HISTORY_FILE}\` — this is done automatically by the orchestrator.`;
  } else if (phase === "research") {
    phaseTask = `## TASK (phase: RESEARCH — search for alternatives)

0. **DIAGNOSTIC**: the current approach has stagnated. Need to search for alternatives.

1. **Search** (WebSearch REQUIRED — minimum 2 searches):
   - Alternative strategies for ${ASSET} 15m
   - Promising indicators and combinations
   - Entry/exit patterns different from current
2. **Propose** 2-3 alternative approaches with:
   - Name, indicators, entry/exit logic, rationale
3. **Choose** the most promising and implement in \`${PINE_FILE}\`
   - May rewrite entire logic sections, but DOCUMENT all changes
4. **Record** in \`${OPT_LOG}\` (APPEND) with research section
5. **Write metadata** to \`${metadataPath}\` with scale: "structural"
   Do NOT edit \`${PARAM_HISTORY_FILE}\`.`;
  } else {
    // restructure
    phaseTask = `## TASK (phase: RESTRUCTURE — implement structural changes)

**CRITICAL**: Your PRIMARY job is to EDIT \`${PINE_FILE}\`. If the research brief describes a new approach that hasn't been applied yet, you MUST rewrite the pine file FIRST, before doing anything else. Do NOT just document changes in the log — actually write the code.

0. **CHECK**: Read \`${PINE_FILE}\` — does it already reflect the research brief's proposed approach?
   - If NO → REWRITE the pine file NOW (step 1)
   - If YES → iterate on it (tune parameters, filters or logic)

1. **EDIT \`${PINE_FILE}\`** (MANDATORY — this is the whole point)
   - Apply the structural rewrite from the research brief
   - Use the MCP pinescript-syntax-checker to validate after editing
   - If syntax fails, fix the errors until it passes

2. **DIAGNOSTIC**:
   - What changed and why
   - Compare with previous approach checkpoint
${searchInstruction}
3. **Record** in \`${OPT_LOG}\` (APPEND) — document what was changed
4. **Write metadata** to \`${metadataPath}\`
   Do NOT edit \`${PARAM_HISTORY_FILE}\`.`;
  }

  const prompt = `Pine Script optimization loop — iteration ${iter}/${maxIter}.
${phaseHeader}

## CONTEXT
- Asset being optimized: ${ASSET} (class: ${ASSET_CLASS})
- Strategy: ${ASSET} 15m long/short with 1h regime filter | Pine: ${PINE_FILE}
- Objective: Hyperliquid perps via actionable signals

## UNMET CRITERIA
${unmetCriteria.join("\n")}

## LAST BACKTEST METRICS
PnL: ${pnlStr} | Trades: ${tradesStr} | PF: ${pfStr} | DD: ${ddStr} | WR: ${wrStr}

${designChecklistSection}${pineParamsSection}
${complexitySection}${overfitSection}${tradeAnalysisSection}
${filterSimsSection}${exploredSpaceSection}${coreParamsSection}${pendingHypothesesSection}${approachHistorySection}${researchSection}${historySection}

${phaseTask}

${pineRules}

## OPTIMIZATION RULES
- **1 change per iteration** (refine phase): maximum 1 parameter or 1 filter. Restructure phase can make larger changes.
- **Core parameters first**: fully sweep core parameter ranges before secondary params.
- **FORBIDDEN: day-of-week filters**. No dayofweek conditions. BTC 15m has no persistent DOW edge.
- **Axis exhaustion**: a core param is only EXHAUSTED when every value in min/max/step has been tested.
- **Directional bias**: if one direction PF < 0.5, diagnosis is STRUCTURAL. Use directional filter, not param tuning.
- **Time stop circular trap**: if avg_winner_duration ≈ time_stop_cap, do NOT increase the cap.
- **Next steps are conditionals, not suggestions**: use format "if [metric X] then [action Y]".
- **Filter simulations are indicative**: actual numbers may differ.
- **ADD-trades vs REMOVE-trades hypotheses**:
  REMOVE-trades: quantifiable impact via filterSimulations → low risk.
  ADD-trades: UNKNOWN quality → high risk, max confidence "Medium".
- Few trades → relax filters; Negative PnL → tune SL/TP, regime
- **Stability rule for hour filters**: only block hour if trainCount≥10 + walk-forward ✓ robust + not 3rd+ consecutive.
- **Axis priority**: core params MUST be tested in STRICT sequential order as listed in CORE PARAMETERS section. Only move to the next core param after the current one is COMPLETE. Only apply diagnostic-based triggers (SL analysis, filter sims) AFTER all core params are fully explored. This overrides any diagnostic findings.
- **FORBIDDEN: category change**. Strategy category (${STRATEGY}) MUST NOT change. Breakout stays breakout, mean-reversion stays mean-reversion. The strategy() title must keep the same category keyword. Restructure may change indicators/logic but NOT the category.
- Save the .pine file after edits
`;

  process.stdout.write(prompt);
}

// --- Section builders (extracted for testability) ---

export function buildTradeAnalysisSection(ta: TradeAnalysis): string {
  return `## TRADE ANALYSIS (pre-processed — do not read the XLSX)
By exit type (exit mechanism):
${(ta.byExitType ?? [])
  .map(
    (e) =>
      `  ${e.signal.padEnd(18)}: ${String(e.count).padStart(3)}t | WR=${String(e.winRate).padStart(5)}% | PnL=${e.pnl >= 0 ? "+" : ""}${e.pnl} USD`,
  )
  .join("\n") || "  (no data)"}

Average duration: winners=${ta.avgBarsWinners ?? "?"} bars | losers=${ta.avgBarsLosers ?? "?"} bars (15m bars)

By direction:
${Object.entries(ta.byDirection)
  .map(
    ([d, v]) =>
      `  ${d}: ${v.count}t, PnL=${v.pnl >= 0 ? "+" : ""}${v.pnl}, WR=${v.winRate}%, PF=${v.profitFactor ?? "?"}, avg=${v.avgTrade >= 0 ? "+" : ""}${v.avgTrade ?? "?"} USD`,
  )
  .join("\n")}

Best hours UTC (by cumulative PnL, min 2 trades):
  ${ta.bestHoursUTC.map((h) => `${String(h.hour).padStart(2, "0")}h: ${h.count}t, ${h.pnl >= 0 ? "+" : ""}${h.pnl} USD`).join(" | ")}
Worst hours UTC:
  ${ta.worstHoursUTC.map((h) => `${String(h.hour).padStart(2, "0")}h: ${h.count}t, ${h.pnl >= 0 ? "+" : ""}${h.pnl} USD`).join(" | ")}

By day of week: ${Object.entries(ta.byDayOfWeek).map(([d, v]) => `${d}:${v.pnl >= 0 ? "+" : ""}${v.pnl}`).join(", ")}
${ta.bySession ? `By session:\n${(["Asia", "London", "NY", "Off-peak"] as SessionName[]).map((s) => {
  const ss = ta.bySession![s];
  return `  ${s.padEnd(9)}: ${String(ss.count).padStart(3)}t | WR=${String(ss.winRate).padStart(5)}% | PF=${String(ss.profitFactor).padStart(5)} | PnL=${ss.pnl >= 0 ? "+" : ""}${ss.pnl} USD`;
}).join("\n")}` : ""}
Best trades: ${ta.best3TradesPnl.join(", ")} USD | Worst: ${ta.worst3TradesPnl.join(", ")} USD
`;
}

export function buildPineParamsSection(
  pineParams: ParseResultsOutput["pineParams"],
): string {
  if (!pineParams) return "";
  const f = pineParams.filters ?? {};
  const on = Object.entries(f)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  const off = Object.entries(f)
    .filter(([, v]) => v === false)
    .map(([k]) => k);

  // Collect all numeric params dynamically
  const skipKeys = new Set(["filters", "blockedHours", "blockedDays"]);
  const numericEntries = Object.entries(pineParams)
    .filter(([k, v]) => !skipKeys.has(k) && typeof v === "number")
    .map(([k, v]) => `${k}=${v}`);

  return `## CURRENT .PINE PARAMETERS (read from file — actual state)
Numeric: ${numericEntries.length ? numericEntries.join(" | ") : "none found"}
Filters ON:  ${on.length ? on.join(", ") : "none"}
Filters OFF: ${off.length ? off.join(", ") : "none"}
`;
}

export function buildComplexitySection(
  pineParams: ParseResultsOutput["pineParams"],
): string {
  if (!pineParams) return "";
  const f = pineParams.filters ?? {};
  const blockedHours = pineParams.blockedHours ?? [];
  const blockedDays = pineParams.blockedDays ?? [];
  const filtersOn = Object.entries(f).filter(([, v]) => v === true).length;
  const totalFilters = blockedHours.length + blockedDays.length + filtersOn;

  const lines = ["## CURRENT COMPLEXITY"];
  lines.push(`Boolean filters ON: ${filtersOn}`);
  lines.push(
    `Blocked hours: ${blockedHours.length} [${blockedHours.join(", ")}]`,
  );
  lines.push(
    `Blocked days: ${blockedDays.length} [${blockedDays.join(", ")}]`,
  );
  lines.push(`Total active filters: ${totalFilters}`);

  const warnings: string[] = [];
  if (blockedHours.length > 12) {
    warnings.push(
      `FORBIDDEN to add more hour filters — ${blockedHours.length}/24 hours already blocked (>50% of day). Explore other axes: atrMult, TP/SL, entry logic, session blocks.`,
    );
  }
  if (blockedDays.length > 3) {
    warnings.push(
      `FORBIDDEN to add more day filters — ${blockedDays.length}/7 days already blocked. Explore other axes.`,
    );
  }
  if (warnings.length) {
    lines.push("");
    for (const w of warnings) lines.push(`⛔ ${w}`);
  }

  return lines.join("\n") + "\n\n";
}

export function buildOverfitSection(
  paramHistory: ParameterHistory | null,
  tradeAnalysis: TradeAnalysis | null,
): string {
  const iters = (paramHistory?.iterations ?? []).filter(
    (i) => i.after !== null,
  );

  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Directional bias detection (runs regardless of iteration count — uses tradeAnalysis)
  if (tradeAnalysis?.byDirection) {
    for (const [dir, stats] of Object.entries(tradeAnalysis.byDirection)) {
      if (stats.count < 10) continue;
      const pf = stats.profitFactor ?? 0;
      if (pf < 0.5) {
        warnings.push(
          `🔴 DIRECTIONAL BIAS: ${dir} PF=${pf}. STRUCTURAL, not PARAMETRIC — use directional filter or disable ${dir} side.`,
        );
        suggestions.push(
          `${dir} side is structurally unprofitable. Consider adding a directional filter (DI+/DI-) or disabling ${dir} entries.`,
        );
      } else if (pf < 0.8) {
        warnings.push(
          `🟡 WEAK DIRECTION: ${dir} PF=${pf}. Monitor closely — may need directional filter.`,
        );
      }
    }
  }

  if (iters.length < 3) {
    // With few iterations, only directional bias warnings apply
    if (!warnings.length) return "";
    const lines = ["## ROBUSTNESS DIAGNOSTIC (auto-generated — read before proposing hypotheses)"];
    for (const w of warnings) lines.push(w);
    if (suggestions.length) {
      lines.push("");
      lines.push("Redirection suggestions:");
      for (const s of suggestions) lines.push(`  → ${s}`);
    }
    return lines.join("\n") + "\n\n";
  }

  // 1. Hour/day filters applied in sequence
  const recentN = iters.slice(-8);
  let hourDayRun = 0;
  for (let i = recentN.length - 1; i >= 0; i--) {
    const p = recentN[i].change?.param ?? "";
    if (
      p === "badHour" ||
      p === "badDay" ||
      p === "useSessionFilter" ||
      p === "useDayFilter"
    )
      hourDayRun++;
    else break;
  }
  const totalHourDayFilters = iters.filter((i) => {
    const p = i.change?.param ?? "";
    return (
      p === "badHour" ||
      p === "badDay" ||
      p === "useSessionFilter" ||
      p === "useDayFilter"
    );
  }).length;

  if (hourDayRun >= 3) {
    warnings.push(
      `🔴 ${hourDayRun} consecutive hour/day filters — high in-sample overfitting risk. Each new filter optimizes the same historical dataset.`,
    );
    suggestions.push(
      "Explore another axis: atrMult, tp1R/tp2R, entry logic, or session blocks instead of individual hours.",
    );
  } else if (hourDayRun >= 2) {
    warnings.push(
      `🟡 ${hourDayRun} consecutive hour/day filters — beware of overfitting.`,
    );
  }

  if (totalHourDayFilters >= 6) {
    warnings.push(
      `🔴 Total of ${totalHourDayFilters} hour/day filters applied in history. Hour patterns are regime-dependent and tend not to generalize.`,
    );
  }

  // 2. Trade count dropping
  const tradeHistory = iters
    .map((i) => i.after?.trades)
    .filter((v): v is number => typeof v === "number");
  if (tradeHistory.length >= 3) {
    const peak = Math.max(...tradeHistory);
    const current = tradeHistory[tradeHistory.length - 1];
    const dropPct = Math.round(((peak - current) / peak) * 100);
    if (dropPct >= 35) {
      warnings.push(
        `🔴 Trade count dropped ${dropPct}% from historical peak (${peak}→${current}). Smaller dataset = less reliable simulations = more noise.`,
      );
      suggestions.push(
        "Consider removing some marginal filters to recover trade volume before continuing optimization.",
      );
    } else if (dropPct >= 20) {
      warnings.push(
        `🟡 Trade count dropped ${dropPct}% from peak (${peak}→${current}).`,
      );
    }
  }

  // 3. Diminishing returns
  if (iters.length >= 5) {
    const deltas = iters
      .slice(-6)
      .map((cur, idx, arr) => {
        if (idx === 0) return null;
        const prev = arr[idx - 1];
        const pnlA = cur.after?.pnl;
        const pnlB = prev.before?.pnl ?? prev.after?.pnl;
        return typeof pnlA === "number" && typeof pnlB === "number"
          ? pnlA - pnlB
          : null;
      })
      .filter((d): d is number => d !== null);

    if (deltas.length >= 4) {
      const half = Math.floor(deltas.length / 2);
      const avgEarly =
        deltas.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const avgLate =
        deltas.slice(half).reduce((a, b) => a + b, 0) /
        (deltas.length - half);
      if (avgEarly > 5 && avgLate < avgEarly * 0.4) {
        warnings.push(
          `🔴 Diminishing returns: average ΔPnL dropped from +${avgEarly.toFixed(0)} USD to +${avgLate.toFixed(0)} USD per iteration. The marginal edge of each change is shrinking.`,
        );
        suggestions.push(
          "Consider stopping incremental optimization and test walk-forward or change axis.",
        );
      }
    }
  }

  // 4. Walk-forward instability
  const wf = tradeAnalysis?.walkForward;
  if (wf) {
    const unstableHours = (wf.hourConsistency ?? []).filter(
      (h) => !h.consistent && Math.abs(h.trainPnl) > 5,
    );
    if (unstableHours.length >= 3) {
      warnings.push(
        `🔴 Walk-forward: ${unstableHours.length} hours have opposite direction between train and test periods. Hour filters are capturing regime-specific noise.`,
      );
      suggestions.push(
        "Prefer session blocks (Asia/Europe/NY) over individual hours — generalize better across regimes.",
      );
    } else if (unstableHours.length >= 1) {
      warnings.push(
        `🟡 Walk-forward: ${unstableHours.length} hour(s) with unstable direction between train and test.`,
      );
    }
  }

  if (!warnings.length) return "";

  const lines = [
    "## ROBUSTNESS DIAGNOSTIC (auto-generated — read before proposing hypotheses)",
  ];
  for (const w of warnings) lines.push(w);
  if (suggestions.length) {
    lines.push("");
    lines.push("Redirection suggestions:");
    for (const s of suggestions) lines.push(`  → ${s}`);
  }
  return lines.join("\n") + "\n\n";
}

export function buildFilterSimsSection(
  tradeAnalysis: TradeAnalysis | null,
): string {
  const sims = tradeAnalysis?.filterSimulations;
  if (!sims || !sims.totalTrades) return "";

  const lines = [
    `## FILTER SIMULATIONS (estimated impact — removal of past trades, not predictive)`,
  ];
  lines.push(
    `Base: ${sims.totalTrades} trades | Total PnL ${sims.totalPnl >= 0 ? "+" : ""}${sims.totalPnl} USD\n`,
  );

  const fmt = (
    h: { tradesAfter: number; tradesRemoved: number; pnlDelta: number; pnlAfter: number },
  ) =>
    `  tradesAfter=${h.tradesAfter} (−${h.tradesRemoved}), ΔPnL=${h.pnlDelta >= 0 ? "+" : ""}${h.pnlDelta} → total est. ${h.pnlAfter >= 0 ? "+" : ""}${h.pnlAfter} USD`;

  const improvingHours = sims.byHour
    .filter((h) => h.pnlDelta > 0)
    .slice(0, 5);
  if (improvingHours.length) {
    lines.push("Block hour — IMPROVES PnL:");
    for (const h of improvingHours)
      lines.push(
        `  ${String(h.hour).padStart(2, "0")}h UTC: ${fmt(h)}`,
      );
  }

  const hurtingHours = sims.byHour
    .filter((h) => h.pnlDelta < 0)
    .slice(-3)
    .reverse();
  if (hurtingHours.length) {
    lines.push("Block hour — WORSENS PnL (do not block these):");
    for (const h of hurtingHours)
      lines.push(
        `  ${String(h.hour).padStart(2, "0")}h UTC: ${fmt(h)}`,
      );
  }

  const improvingDays = sims.byDay.filter((d) => d.pnlDelta > 0);
  if (improvingDays.length) {
    lines.push("Block day — IMPROVES PnL (INFORMATION ONLY — day filters FORBIDDEN):");
    for (const d of improvingDays) lines.push(`  ${d.day}: ${fmt(d)}`);
  }

  const hurtingDays = sims.byDay.filter((d) => d.pnlDelta < 0);
  if (hurtingDays.length) {
    lines.push("Block day — WORSENS PnL (INFORMATION ONLY — day filters FORBIDDEN):");
    for (const d of hurtingDays) lines.push(`  ${d.day}: ${fmt(d)}`);
  }

  const sl = sims.removeAllSL;
  if (sl.tradesRemoved > 0) {
    lines.push(
      `Upper bound (remove all SL): tradesAfter=${sl.tradesAfter} (−${sl.tradesRemoved}), ΔPnL=${sl.pnlDelta >= 0 ? "+" : ""}${sl.pnlDelta} → total est. ${sl.pnlAfter >= 0 ? "+" : ""}${sl.pnlAfter} USD`,
    );
    const ratio =
      Math.abs(sims.totalPnl) > 0.01
        ? (sl.pnlDelta / Math.abs(sims.totalPnl)).toFixed(1)
        : "∞";
    const slCritical = sl.pnlDelta > Math.abs(sims.totalPnl);
    lines.push(
      `  → SL destroys ${ratio}× current PnL${slCritical ? " (informational — follow core param priority)" : ""}`,
    );
  }

  const wf = tradeAnalysis?.walkForward;
  if (wf?.hourConsistency?.length) {
    lines.push(
      `\nWalk-forward (train=${wf.trainTrades}t / test=${wf.testTrades}t, split ${Math.round(wf.splitRatio * 100)}/${Math.round((1 - wf.splitRatio) * 100)}):`,
    );
    if (wf.trainPF !== null || wf.testPF !== null) {
      const trainPFStr = wf.trainPF !== null ? wf.trainPF.toFixed(2) : "N/A";
      const testPFStr = wf.testPF !== null ? wf.testPF.toFixed(2) : "N/A";
      const ratioStr = wf.pfRatio !== null ? wf.pfRatio.toFixed(2) : "N/A";
      lines.push(`  PF train: ${trainPFStr} | PF test: ${testPFStr} | Ratio: ${ratioStr}`);
      if (wf.overfitFlag) {
        lines.push(`  ⚠️ OVERFIT DETECTED: PF_test / PF_train < 0.6 — strategy likely overfitted to training period`);
      }
    }
    lines.push(
      "  Hour | Train PnL (n) | Test PnL (n) | Robust?",
    );
    for (const h of wf.hourConsistency.sort(
      (a, b) => a.trainPnl - b.trainPnl,
    )) {
      const robustLabel =
        h.consistent === true
          ? "✓ yes"
          : h.consistent === false
            ? "✗ NO (unstable — regime-specific)"
            : "? no data";
      const hStr = String(h.hour).padStart(2, "0");
      lines.push(
        `  ${hStr}h UTC | ${h.trainPnl >= 0 ? "+" : ""}${h.trainPnl} (${h.trainCount}t) | ${h.testPnl >= 0 ? "+" : ""}${h.testPnl} (${h.testCount}t) | ${robustLabel}`,
      );
    }
    lines.push(
      "  RULE: only consider blocking hour with ✓ robust AND trainCount≥10.",
    );
  }

  return lines.join("\n") + "\n\n";
}

export function buildExploredSpaceSection(
  paramHistory: ParameterHistory | null,
  globalIter: number,
  iter: number,
  maxIter: number,
): string {
  if (!paramHistory) return "";

  const lines = ["## EXPLORED SPACE (do not repeat)"];

  const ranges = paramHistory.exploredRanges ?? {};
  const rangeEntries = Object.entries(ranges).filter(
    ([, vals]) => Array.isArray(vals) && vals.length > 0,
  );
  if (rangeEntries.length) {
    for (const [param, values] of rangeEntries) {
      lines.push(`${param}: tested [${(values as unknown[]).join(", ")}]`);
    }
  }

  const neverWorked = paramHistory.neverWorked ?? [];
  if (neverWorked.length) {
    lines.push("\nNever worked:");
    for (const item of neverWorked) {
      const label =
        typeof item === "string"
          ? item
          : `${item.param}=${item.value} [${item.reason ?? "?"}] iter${item.iter ?? "?"}: ${item.note ?? ""}`;
      lines.push(`- ${label}`);
    }
  }

  const doneIters = (paramHistory.iterations ?? [])
    .filter((i) => i.after !== null)
    .slice(-3);
  if (doneIters.length) {
    lines.push("\nLatest changes with results:");
    for (const i of doneIters) {
      const v =
        i.verdict === "improved"
          ? "✓"
          : i.verdict === "degraded"
            ? "✗"
            : "⚠";
      const chg = i.change
        ? `${i.change.param} ${i.change.from}→${i.change.to}`
        : "(?)";
      const note = i.note ? ` — ${i.note}` : "";
      lines.push(
        `- iter ${i.iter}: ${chg} | PnL ${i.before?.pnl ?? "?"}→${i.after?.pnl ?? "?"} USD ${v}${note}`,
      );
    }
  }

  lines.push(
    `\nGlobal iteration: ${globalIter} (loop iter ${iter}/${maxIter})`,
  );

  if (lines.length <= 2) return "";
  return lines.join("\n") + "\n\n";
}

export function buildPendingHypothesesSection(
  paramHistory: ParameterHistory | null,
): string {
  if (!paramHistory) return "";
  const pending = (paramHistory.pendingHypotheses ?? []).filter(
    (h) => !h.expired,
  );
  if (!pending.length) return "";

  const lines = [
    "## PENDING HYPOTHESES FROM PREVIOUS ITERATIONS",
  ];
  for (const h of pending) {
    const cond = h.condition ? ` (condition: ${h.condition})` : "";
    lines.push(
      `- iter ${h.iter} rank#${h.rank}: ${h.hypothesis}${cond}`,
    );
  }
  return lines.join("\n") + "\n\n";
}

export function buildApproachHistorySection(paramHistory: ParameterHistory | null): string {
  if (!paramHistory?.approaches?.length) return "";

  const lines = ["## APPROACH HISTORY (do not rediscover exhausted)"];
  for (const a of paramHistory.approaches) {
    const verdict = a.verdict === "exhausted" ? "❌ EXHAUSTED" : a.verdict === "active" ? "🟢 ACTIVE" : "⚡ PROMISING";
    lines.push(`- #${a.id} "${a.name}" [${a.indicators.join(", ")}] iter ${a.startIter}-${a.endIter} | bestScore=${a.bestScore} | PnL=$${a.bestMetrics.pnl} PF=${a.bestMetrics.pf} WR=${a.bestMetrics.wr}% | ${verdict}${a.reason ? ` (${a.reason})` : ""}`);
  }
  return lines.join("\n") + "\n\n";
}

export function buildDiagnosticInstruction(phase: string): string {
  return phase === "refine"
    ? `Mandatory DIAGNOSTIC: classify as PARAMETRIC or STRUCTURAL before proposing hypotheses.`
    : `DIAGNOSTIC: evaluate if current approach is progressing.`;
}

export function buildCoreParamsSection(
  coreParams: CoreParameterDef[] | undefined,
  exploredRanges: Record<string, unknown[]> | undefined,
): string {
  if (!coreParams?.length) return "";

  const lines = ["## CORE PARAMETERS (STRICT SEQUENTIAL ORDER — must be fully explored before secondary params)"];
  let allComplete = true;
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

    if (remaining.length > 0) {
      allComplete = false;
      if (!foundIncomplete) {
        // First incomplete param — this is the one to test next
        foundIncomplete = true;
        lines.push(`${cp.name}: ${status}, remaining: [${remaining.join(", ")}] → NEXT (test this param now)`);
      } else {
        // Subsequent incomplete params — blocked until previous ones are done
        lines.push(`${cp.name}: ${status}, remaining: [${remaining.join(", ")}] [BLOCKED — wait for previous params]`);
      }
    } else {
      lines.push(`${cp.name}: ${status}`);
    }
  }

  if (!allComplete) {
    lines.push("");
    lines.push("RULE: Core params MUST be tested in STRICT SEQUENTIAL ORDER. Only the param marked → NEXT can be changed.");
    lines.push("Params marked [BLOCKED] CANNOT be touched until all previous params are COMPLETE.");
    lines.push("Diagnostic triggers (SL analysis, filter sims) do NOT override this order.");
  }

  return lines.join("\n") + "\n\n";
}

export function buildDesignChecklistSection(
  checklist: string[] | undefined,
  globalIter: number,
): string {
  if (!checklist?.length || globalIter !== 1) return "";

  const lines = ["## PRE-CHECK: validate .pine implements ALL components. Implement missing before optimizing."];
  for (const item of checklist) {
    lines.push(`[ ] ${item}`);
  }
  return lines.join("\n") + "\n\n";
}

// Only run main() when executed directly, not when imported for tests
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("build-optimize-prompt.js");

if (isMain) {
  main();
}
