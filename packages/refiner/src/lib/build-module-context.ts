/**
 * build-module-context.ts
 *
 * Centralizes the mapping from strategy profile → KB module context.
 * Used by research, optimize, and fix stages to inject module-aware
 * context (fixed rules, var caps, stopping criteria) into prompts.
 */

import fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Module-level context extracted from the KB */
export interface ModuleContext {
  /** e.g. "breakout", "mean-reversion", "pullback", "trend-following" */
  profile: string;
  /** e.g. "M1", "M2", "M3", "M4" */
  moduleId: string;
  /** Human-readable name */
  moduleName: string;
  /** Fixed rules text (section X.1) — injected verbatim */
  fixedRules: string;
  /** Current RESTRUCTURE locks (e.g. "band: KC, confirmation: RSI, regime: ADX") */
  restructureLocks: string;
  /** Max free variables for this module */
  varCap: number;
  /** Stopping criteria for this module */
  stoppingCriteria: string;
  /** Signal TF */
  signalTF: string;
  /** Regime TF */
  regimeTF: string;
}

/** Context for a failed optimization attempt */
export interface FailureContext {
  /** What was tried */
  approachName: string;
  /** Why it failed — the specific metric(s) that missed */
  failureMode: string;
  /** Metrics from the failed run */
  metrics: { pnl: number; pf: number; wr: number; dd: number; trades: number; avgR: number };
}

// ---------------------------------------------------------------------------
// KB-aligned stopping criteria per module (source of truth: KB sections 3-6, 10)
// ---------------------------------------------------------------------------

export const MODULE_CRITERIA: Record<string, {
  minTrades: number;
  minPF: number;
  maxDD: number;
  minWR: number | null;    // null = no WR gate for this module
  minAvgR: number | null;  // null = no avgR gate
  minPfRatio: number;
}> = {
  M1: { minTrades: 50,  minPF: 1.3, maxDD: 10, minWR: null, minAvgR: 0.15, minPfRatio: 0.6 },
  M2: { minTrades: 80,  minPF: 1.3, maxDD: 8,  minWR: 50,   minAvgR: null, minPfRatio: 0.6 },
  M3: { minTrades: 50,  minPF: 1.4, maxDD: 10, minWR: null, minAvgR: 0.15, minPfRatio: 0.6 },
  M4: { minTrades: 30,  minPF: 1.4, maxDD: 12, minWR: null, minAvgR: 0.20, minPfRatio: 0.6 },
};

// ---------------------------------------------------------------------------
// Static module mapping
// ---------------------------------------------------------------------------

interface ModuleMapping {
  moduleId: string;
  moduleName: string;
  regimeTF: string;
  defaultVarCap: number;
  kbSection: number;
}

const MODULE_MAP: Record<string, ModuleMapping> = {
  breakout:          { moduleId: "M1", moduleName: "Breakout",          regimeTF: "4H or Daily", defaultVarCap: 8, kbSection: 3 },
  "mean-reversion":  { moduleId: "M2", moduleName: "Mean Reversion",    regimeTF: "1H",          defaultVarCap: 6, kbSection: 4 },
  pullback:          { moduleId: "M3", moduleName: "Pullback",          regimeTF: "4H",          defaultVarCap: 8, kbSection: 5 },
  "trend-following": { moduleId: "M4", moduleName: "Trend Following",   regimeTF: "Daily",       defaultVarCap: 6, kbSection: 6 },
};

// ---------------------------------------------------------------------------
// KB extraction
// ---------------------------------------------------------------------------

/**
 * Extract the fixed rules block from the KB for a given section number.
 * Looks for `### X.1 Fixed rules` and reads until the next `###` or `---`.
 */
export function extractFixedRules(kbContent: string, sectionNumber: number): string {
  const marker = `### ${sectionNumber}.1 Fixed rules`;
  const startIdx = kbContent.indexOf(marker);
  if (startIdx === -1) return "(fixed rules not found in KB)";

  // Skip the header line itself
  const afterHeader = kbContent.indexOf("\n", startIdx);
  if (afterHeader === -1) return "(fixed rules not found in KB)";

  const rest = kbContent.slice(afterHeader + 1);

  // Find the next section boundary: ### or ---
  const lines = rest.split("\n");
  const ruleLines: string[] = [];
  for (const line of lines) {
    if (/^#{3,4}\s/.test(line) || /^---\s*$/.test(line)) break;
    ruleLines.push(line);
  }

  // Trim trailing empty lines
  while (ruleLines.length > 0 && ruleLines[ruleLines.length - 1].trim() === "") {
    ruleLines.pop();
  }

  return ruleLines.join("\n") || "(fixed rules section empty)";
}

// ---------------------------------------------------------------------------
// Stopping criteria formatter
// ---------------------------------------------------------------------------

function formatStoppingCriteria(moduleId: string): string {
  const mc = MODULE_CRITERIA[moduleId];
  if (!mc) return "(unknown module)";

  const lines = [
    `- PnL > 0`,
    `- Trades >= ${mc.minTrades}`,
    `- PF >= ${mc.minPF}`,
    `- DD <= ${mc.maxDD}%`,
  ];

  if (mc.minWR !== null) {
    lines.push(`- WR >= ${mc.minWR}% [mandatory for this module]`);
  }

  if (mc.minAvgR !== null) {
    lines.push(`- avgR >= ${mc.minAvgR}R`);
  }

  lines.push(`- pfRatio >= ${mc.minPfRatio}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

interface BuildModuleContextOptions {
  strategy: string;
  interval: string;
  criteria: { maxFreeVariables?: number };
  paramHistory?: { restructureLocks?: string };
}

/**
 * Build a ModuleContext from loop config and KB content.
 */
export function buildModuleContext(
  cfg: BuildModuleContextOptions,
  kbPath: string,
): ModuleContext {
  const mapping = MODULE_MAP[cfg.strategy];
  if (!mapping) {
    throw new Error(`Unknown strategy profile: "${cfg.strategy}". Expected one of: ${Object.keys(MODULE_MAP).join(", ")}`);
  }

  let kbContent = "";
  try {
    kbContent = fs.readFileSync(kbPath, "utf8");
  } catch {
    // KB not available — fixedRules will be placeholder
  }

  const fixedRules = extractFixedRules(kbContent, mapping.kbSection);
  const varCap = cfg.criteria.maxFreeVariables ?? mapping.defaultVarCap;
  const stoppingCriteria = formatStoppingCriteria(mapping.moduleId);
  const restructureLocks = cfg.paramHistory?.restructureLocks ?? "";

  return {
    profile: cfg.strategy,
    moduleId: mapping.moduleId,
    moduleName: mapping.moduleName,
    fixedRules,
    restructureLocks,
    varCap,
    stoppingCriteria,
    signalTF: cfg.interval,
    regimeTF: mapping.regimeTF,
  };
}
