import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { StageResult } from "../types.js";
import { runClaude } from "./run-claude.js";
import { safeJsonParse } from "../../lib/safe-json.js";
import type { ModuleContext, FailureContext } from "../../lib/build-module-context.js";
import { formatCatalogForPrompt } from "../../automation/build-optimize-prompt.js";

// Re-export for downstream consumers
export type { ModuleContext, FailureContext };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchBrief {
  module: string;
  queries: string[];
  findings: { source: string; summary: string; verified: boolean }[];
  suggestedApproaches: SuggestedApproach[];
  timestamp: string;
}

export interface SuggestedApproach {
  name: string;
  indicators: string[];
  entryLogic: string;
  exitLogic: string;
  rationale: string;
  estimatedVars: number;
  complianceNotes: string;
  expectedMetrics: {
    estimatedWR: string;
    estimatedPF: string;
    estimatedAvgR: string;
  };
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

// ---------------------------------------------------------------------------
// P5.1: Research priority — criteria distance
// ---------------------------------------------------------------------------

function buildResearchPriority(
  currentMetrics: { pnl: number; pf: number; wr: number; dd: number; trades: number; avgR: number },
  criteria?: { minTrades?: number; minPF?: number; maxDD?: number; minWR?: number | null; minAvgR?: number | null },
): string {
  if (!criteria) return "";

  const gaps: Array<{ label: string; gap: number; severity: string }> = [];

  if ((criteria.minPF ?? 0) > 0 && currentMetrics.pf < (criteria.minPF ?? 0)) {
    const gap = (criteria.minPF ?? 0) - currentMetrics.pf;
    gaps.push({ label: `PF: ${currentMetrics.pf.toFixed(2)} → need ${criteria.minPF} (gap: ${gap.toFixed(2)})`, gap, severity: gap > 0.5 ? "CRITICAL" : "MODERATE" });
  }
  if (currentMetrics.pnl <= 0) {
    gaps.push({ label: `PnL: $${currentMetrics.pnl.toFixed(0)} → need >0 (gap: $${Math.abs(currentMetrics.pnl).toFixed(0)})`, gap: Math.abs(currentMetrics.pnl), severity: "CRITICAL" });
  }
  const absDd = Math.abs(currentMetrics.dd);
  if ((criteria.maxDD ?? 100) < absDd) {
    const gap = absDd - (criteria.maxDD ?? 100);
    gaps.push({ label: `DD: ${absDd.toFixed(1)}% → need ≤${criteria.maxDD}% (gap: ${gap.toFixed(1)}%)`, gap, severity: gap > 10 ? "SEVERE" : "MODERATE" });
  }
  if (criteria.minWR != null && currentMetrics.wr < criteria.minWR) {
    const gap = criteria.minWR - currentMetrics.wr;
    gaps.push({ label: `WR: ${currentMetrics.wr.toFixed(1)}% → need ≥${criteria.minWR}% (gap: ${gap.toFixed(1)}%)`, gap, severity: gap > 10 ? "SEVERE" : "MODERATE" });
  }
  if (criteria.minAvgR != null && currentMetrics.avgR < criteria.minAvgR) {
    const gap = criteria.minAvgR - currentMetrics.avgR;
    gaps.push({ label: `avgR: ${currentMetrics.avgR.toFixed(3)} → need ≥${criteria.minAvgR} (gap: ${gap.toFixed(3)})`, gap, severity: gap > 0.1 ? "MODERATE" : "LOW" });
  }

  const tradesMet = (criteria.minTrades ?? 0) <= currentMetrics.trades;
  if (!tradesMet) {
    gaps.push({ label: `Trades: ${currentMetrics.trades} → need ≥${criteria.minTrades} (gap: ${(criteria.minTrades ?? 0) - currentMetrics.trades})`, gap: (criteria.minTrades ?? 0) - currentMetrics.trades, severity: "MODERATE" });
  }

  if (gaps.length === 0) return "";

  // Sort by severity (CRITICAL first) then gap size
  const severityOrder: Record<string, number> = { CRITICAL: 0, SEVERE: 1, MODERATE: 2, LOW: 3 };
  gaps.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3) || b.gap - a.gap);

  const lines = ["\n## RESEARCH PRIORITY (address in this order)"];
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    lines.push(`${i + 1}. ${g.label} ← ${g.severity}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function conductResearch(opts: {
  asset: string;
  moduleContext: ModuleContext;
  currentMetrics: { pnl: number; pf: number; wr: number; dd: number; trades: number; avgR: number };
  failureHistory: FailureContext[];
  exhaustedApproaches: string[];
  artifactsDir: string;
  model: string;
  timeoutMs: number;
  repoRoot: string;
  kbPath: string;
  allowedDomains?: string[];
  criteria?: { minTrades?: number; minPF?: number; maxDD?: number; minWR?: number | null; minAvgR?: number | null };
}): Promise<StageResult<ResearchBrief>> {
  const {
    asset, moduleContext, currentMetrics, failureHistory,
    exhaustedApproaches, artifactsDir, model, timeoutMs,
    repoRoot, kbPath, allowedDomains, criteria,
  } = opts;

  const briefPath = path.join(artifactsDir, "research-brief.json");

  // Delete stale brief from previous attempt
  try { fs.unlinkSync(briefPath); } catch { /* ignore */ }

  // -----------------------------------------------------------------------
  // Build prompt sections
  // -----------------------------------------------------------------------

  const exhaustedSection = exhaustedApproaches.length > 0
    ? `\n## Exhausted Approaches (do NOT repeat these)\n${exhaustedApproaches.map((a) => `- ${a}`).join("\n")}`
    : "";

  const failureSection = failureHistory.length > 0
    ? `\n## Failure History (understand WHY previous attempts failed)\n${failureHistory.map((f) =>
      `- **${f.approachName}**: ${f.failureMode}\n  Metrics: PF=${f.metrics.pf}, WR=${f.metrics.wr}%, DD=${f.metrics.dd}%, trades=${f.metrics.trades}, avgR=${f.metrics.avgR}`,
    ).join("\n")}`
    : "";

  const domainSection = allowedDomains && allowedDomains.length > 0
    ? `\n## Source Quality Tiers
Trusted domains: ${allowedDomains.join(", ")}
- Findings from trusted domains: mark verified=true
- Findings from OTHER domains: mark verified=false and note "[UNVERIFIED SOURCE]" in summary
- Most trading blogs are low-quality affiliate content — prefer academic papers, backtested studies, and exchange documentation`
    : "";

  const restructureSection = moduleContext.restructureLocks
    ? `\n## RESTRUCTURE Locks (architecture decisions already made — do NOT suggest changing these)
${moduleContext.restructureLocks}
Research must suggest improvements WITHIN this architecture. Changing the architecture requires explicit RESTRUCTURE approval.`
    : "";

  const catalogSection = moduleContext.catalog.slots.length > 0
    ? `\n## KB Component Catalog (extracted — prefer these over novel approaches)\n${formatCatalogForPrompt(moduleContext.catalog, [], moduleContext.restructureLocks)}`
    : "";

  // P5.1: Research priority — compute criteria distance
  const prioritySection = buildResearchPriority(currentMetrics, criteria);


  // -----------------------------------------------------------------------
  // Main prompt
  // -----------------------------------------------------------------------

  const prompt = `You are a quantitative trading researcher working within a structured trading system.
Your task is to research improvements for the **${moduleContext.moduleName}** module (${moduleContext.moduleId}) trading ${asset}.

## System Context
- Signal TF: ${moduleContext.signalTF} | Regime TF: ${moduleContext.regimeTF}
- BREAKER profile: \`${moduleContext.profile}\`
- Max free variables: ${moduleContext.varCap} (HARD CAP — any suggestion exceeding this is rejected)

## Fixed Rules (BREAKER cannot change these — your suggestions MUST comply)
${moduleContext.fixedRules}

## Stopping Criteria (targets your suggestions must be designed to meet)
${moduleContext.stoppingCriteria}
${restructureSection}

## Current Performance
- Asset: ${asset}
- PnL: $${currentMetrics.pnl}
- Profit Factor: ${currentMetrics.pf}
- Win Rate: ${currentMetrics.wr}%
- Max Drawdown: ${currentMetrics.dd}%
- Trade count: ${currentMetrics.trades}
- Average R: ${currentMetrics.avgR}
${prioritySection}${failureSection}${exhaustedSection}${domainSection}${catalogSection}

## Knowledge Base
Read the knowledge base at: ${kbPath}
Focus on section ${moduleContext.moduleId === "M1" ? "3" : moduleContext.moduleId === "M2" ? "4" : moduleContext.moduleId === "M3" ? "5" : "6"} (${moduleContext.moduleName}) for:
- Strategy candidates table (known viable approaches)
- Variable budget table (how vars are typically allocated)
- Key research insights (what prior research found)
- Rationale section (why rules exist — do not violate)

## Research Instructions
1. Read the KB module section first to understand what has already been researched
2. Use WebSearch to find 2-3 approaches that:
   - Fit the ${moduleContext.profile} archetype
   - Comply with ALL fixed rules above
   - Stay within ${moduleContext.varCap} free variables
   - Are supported by backtests or academic research (not just blog opinions)
   - Address the specific failure mode(s) from history (if any)
3. For each approach, estimate var count and verify rule compliance
4. Prefer approaches from the KB candidates table that haven't been tried yet
5. Only suggest novel approaches if KB candidates are exhausted

## Output
Write ONLY a JSON file to ${briefPath} with this structure:
{
  "module": "${moduleContext.moduleId}",
  "queries": ["search query 1", "search query 2"],
  "findings": [
    {"source": "url", "summary": "what was found", "verified": true}
  ],
  "suggestedApproaches": [
    {
      "name": "Approach Name",
      "indicators": ["indicator1", "indicator2"],
      "entryLogic": "Precise entry conditions",
      "exitLogic": "Precise exit conditions (stop, TP, trail, timeout)",
      "rationale": "Why this addresses the failure mode and fits the archetype",
      "estimatedVars": 5,
      "complianceNotes": "How this complies with each fixed rule. Note any rule that needs attention.",
      "expectedMetrics": {
        "estimatedWR": "35-45%",
        "estimatedPF": "1.4-1.8",
        "estimatedAvgR": "0.20-0.35"
      }
    }
  ],
  "timestamp": "${new Date().toISOString()}"
}

CRITICAL:
- estimatedVars MUST be <= ${moduleContext.varCap}
- Every approach MUST comply with ALL fixed rules
- exitLogic MUST be specified (not just entry)
- If a RESTRUCTURE lock exists, work within it
- Do NOT write or modify any file other than ${briefPath}`;

  // -----------------------------------------------------------------------
  // Execute
  // -----------------------------------------------------------------------

  try {
    const result = await runClaude(
      [
        "--model", model,
        "--dangerously-skip-permissions",
        "--allowedTools", "WebSearch,mcp__context7__resolve-library-id,mcp__context7__query-docs,Read,Write",
        "-p", prompt,
      ],
      { cwd: repoRoot, timeoutMs, label: "research" },
    );

    if (result.status !== 0) {
      log(`Research Claude exited with code ${result.status}`);
      return { success: false, error: `Research failed: exit code ${result.status}` };
    }

    if (!fs.existsSync(briefPath)) {
      log("Research brief file not created — falling back");
      return { success: false, error: "research-brief.json not created" };
    }

    // ---------------------------------------------------------------------
    // Parse & validate
    // ---------------------------------------------------------------------

    const raw = fs.readFileSync(briefPath, "utf8");

    const researchBriefSchema = z.object({
      module: z.string().default(moduleContext.moduleId),
      queries: z.array(z.string()).default([]),
      findings: z.array(z.object({
        source: z.string(),
        summary: z.string(),
        verified: z.boolean().default(false),
      })).default([]),
      suggestedApproaches: z.array(z.object({
        name: z.string(),
        indicators: z.array(z.string()),
        entryLogic: z.string(),
        exitLogic: z.string(),
        rationale: z.string(),
        estimatedVars: z.number(),
        complianceNotes: z.string(),
        expectedMetrics: z.object({
          estimatedWR: z.string().default("unknown"),
          estimatedPF: z.string().default("unknown"),
          estimatedAvgR: z.string().default("unknown"),
        }).default({}),
      })),
      timestamp: z.string().default(""),
    });

    let brief: ResearchBrief;
    try {
      brief = safeJsonParse(raw, { repair: true, schema: researchBriefSchema }) as ResearchBrief;
    } catch (parseErr) {
      const errMsg = (parseErr as Error).message || "";
      log("Research brief failed validation — falling back");
      if (errMsg.includes("suggestedApproaches")) {
        return { success: false, error: "research-brief.json missing suggestedApproaches" };
      }
      return { success: false, error: `research-brief.json validation failed: ${errMsg}` };
    }

    if (brief.suggestedApproaches.length === 0) {
      return { success: false, error: "research-brief.json has no suggestedApproaches" };
    }

    // -----------------------------------------------------------------
    // Post-validation: reject approaches that exceed var cap
    // -----------------------------------------------------------------

    const compliant = brief.suggestedApproaches.filter((a) => {
      if (a.estimatedVars > moduleContext.varCap) {
        log(`Rejecting "${a.name}": ${a.estimatedVars} vars exceeds cap of ${moduleContext.varCap}`);
        return false;
      }
      return true;
    });

    if (compliant.length === 0) {
      return {
        success: false,
        error: `All suggested approaches exceed var cap of ${moduleContext.varCap}`,
      };
    }

    brief.suggestedApproaches = compliant;

    return { success: true, data: brief };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}