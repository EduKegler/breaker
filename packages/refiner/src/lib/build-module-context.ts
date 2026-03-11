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

/** A single candidate component from the KB catalog */
export interface CatalogCandidate {
  name: string;
  slug: string;
  description: string;
}

/** A named slot (e.g. "Entry Signal") with its candidates */
export interface CatalogSlot {
  slotName: string;
  candidates: CatalogCandidate[];
  /** Typical vars consumed by this slot (from KB variable budget table) */
  typicalVars?: string;
  /** Whether this slot is optional for variant generation (e.g., M1 Entry Timing, Confirmation) */
  optional?: boolean;
}

/** Full component catalog for a module, parsed from KB */
export interface ComponentCatalog {
  slots: CatalogSlot[];
}

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
  /** Component catalog parsed from KB strategy candidates section */
  catalog: ComponentCatalog;
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
// Candidate slugs — deterministic short names for KB catalog components
// ---------------------------------------------------------------------------

/**
 * Pre-defined slugs for all known KB catalog candidates.
 * Used to build deterministic, human-readable variant file names.
 * The prompt shows slugs to Claude, Claude returns slugs, buildVariantId() joins them.
 */
export const CANDIDATE_SLUGS: Record<string, string> = {
  // ── M1 Breakout: Direction Constraint ──
  "Both": "both",
  "Long only": "long",
  "Short only": "short",
  // ── M1 Breakout: Entry Signal ──
  "Donchian Channel": "donchian",
  "Bollinger Band squeeze release": "squeeze",
  "BB squeeze release": "squeeze",
  "Opening Range Breakout (ORB)": "orb",
  "Range breakout": "range",
  "Volatility expansion": "expansion",
  // ── M1 Breakout: Entry Timing ──
  "Breakout close": "close",
  "Retest entry": "retest",
  // ── M1 Breakout: Regime Filter ──
  "EMA direction": "ema",
  "EMA direction + slope": "ema-slope",
  "Daily EMA": "ema",
  "ADX threshold": "adx",
  "4H consolidation": "consolidation",
  // ── M1 Breakout: Confirmation ──
  "RSI momentum": "rsi",
  "MACD alignment": "macd",
  "Volume spike": "vol-spike",
  // ── M1 Breakout: Exit ──
  "Trailing channel (Donchian fast)": "trail-dc",
  "ATR trailing stop": "atr-trail",
  "Time-based timeout": "timeout",
  "Partial TP + trail": "partial-tp",
  // ── M2 Mean-Reversion: Band/Channel ──
  "Bollinger Bands": "bollinger",
  "Keltner Channels": "keltner",
  "Percentage bands": "pct-bands",
  "VWAP bands": "vwap",
  // ── M2 Mean-Reversion: Exhaustion ──
  "RSI(2)": "rsi2",
  "Williams %R": "williams",
  "RSI(3-5)": "rsi35",
  "Stochastic": "stochastic",
  // ── M2 Mean-Reversion: Regime Filter ──
  "ADX threshold (low)": "adx-low",
  "BB width / volatility percentile": "bb-width",
  "MA slope flat": "ma-flat",
  // ── M2 Mean-Reversion: Exit ──
  "Channel midline": "midline",
  "Opposite band": "opposite",
  "First up/down close": "first-close",
  "Timeout": "timeout",
  "Catastrophic stop": "cat-stop",
  "Catastrophic stop (optional)": "cat-stop",
  // ── M3 Pullback: Trend Filter ──
  // "EMA direction" already mapped above
  "HH/HL structure": "hhhl",
  "ADX > threshold": "adx-high",
  // ── M3 Pullback: Pullback Zone ──
  "Fibonacci retracement": "fib",
  "EMA dynamic support": "ema-support",
  "9/30 pullback zone": "930",
  "Prior S/R level": "sr",
  // ── M3 Pullback: Pullback Confirm ──
  "RSI neutral reset": "rsi-reset",
  "Candlestick pattern": "candle",
  "Volume expansion": "volume",
  "Candle close beyond pullback extreme": "close-beyond",
  // ── M3 Pullback: Exit ──
  "Prior swing high/low": "swing",
  // "ATR trailing stop" already mapped above
  "Fibonacci extension": "fib-ext",
  // "Time-based timeout" already mapped above
  // "Partial TP + trail" already mapped above
  // ── M4 Trend Following: Entry Signal ──
  "SuperTrend flip": "supertrend",
  "EMA crossover": "ema-cross",
  "MA crossover": "ema-cross",
  "Donchian channel breakout": "donchian-daily",
  "Price channel breakout": "donchian-daily",
  "MACD crossover + HTF filter": "macd-htf",
  // ── M4 Trend Following: Regime Filter ──
  // "ADX > threshold" already mapped above
  "EMA slope + price position": "ema-slope",
  // ── M4 Trend Following: Trailing Exit ──
  "Chandelier Exit": "chandelier",
  "SuperTrend flip exit": "supertrend",
  // "ATR trailing stop" already mapped above
  "MA crossover exit": "ma-exit",
  // "Time-based timeout" already mapped above
};

/**
 * Convert a catalog candidate name to its slug.
 * Falls back to kebab-case of the first 3 words if not found.
 */
export function candidateToSlug(name: string): string {
  const slug = CANDIDATE_SLUGS[name];
  if (slug) return slug;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 3)
    .join("-");
}

// ---------------------------------------------------------------------------
// KB-aligned stopping criteria per module (source of truth: KB sections 3-6, 10)
// ---------------------------------------------------------------------------

export const MODULE_CRITERIA: Record<string, {
  minTrades: number;
  minPF: number;
  maxDD: number;
  minWR: number | null;        // null = no WR gate for this module
  minAvgR: number | null;      // null = no avgR gate
  minPfRatio: number;
  wrWarnMax: number | null;    // soft warning threshold (archetype drift)
  wrRejectMax: number | null;  // hard reject threshold (archetype drift)
  expectedDegradation: number; // 0.3 = 30% backtest→live degradation
}> = {
  M1: { minTrades: 50,  minPF: 1.3, maxDD: 10, minWR: null, minAvgR: 0.15, minPfRatio: 0.6, wrWarnMax: 50,  wrRejectMax: 65,  expectedDegradation: 0.3 },
  M2: { minTrades: 80,  minPF: 1.3, maxDD: 8,  minWR: 50,   minAvgR: null, minPfRatio: 0.6, wrWarnMax: 75,  wrRejectMax: 80,  expectedDegradation: 0.3 },
  M3: { minTrades: 50,  minPF: 1.4, maxDD: 10, minWR: null, minAvgR: 0.15, minPfRatio: 0.6, wrWarnMax: 60,  wrRejectMax: 70,  expectedDegradation: 0.3 },
  M4: { minTrades: 30,  minPF: 1.4, maxDD: 12, minWR: null, minAvgR: 0.20, minPfRatio: 0.6, wrWarnMax: 55,  wrRejectMax: 65,  expectedDegradation: 0.3 },
};

/**
 * Compute stretch criteria for a module, accounting for expected
 * backtest→live degradation. E.g. with 30% degradation and minPF=1.3,
 * stretch PF = 1.3 / 0.7 ≈ 1.86 — the target that survives live.
 */
export function computeStretchCriteria(
  moduleId: string,
): { stretchPF: number; stretchAvgR: number | null } {
  const mc = MODULE_CRITERIA[moduleId];
  if (!mc) return { stretchPF: 1.3, stretchAvgR: null };
  const factor = 1 / (1 - mc.expectedDegradation);
  return {
    stretchPF: Math.round(mc.minPF * factor * 100) / 100,
    stretchAvgR: mc.minAvgR !== null ? Math.round(mc.minAvgR * factor * 100) / 100 : null,
  };
}

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
// Component catalog extraction
// ---------------------------------------------------------------------------

/**
 * Maps each module to the markdown bold headers that identify its candidate
 * tables in the KB. Order defines the slot display order in prompts.
 */
const MODULE_SLOT_HEADERS: Record<string, { slotName: string; header: string; optional?: boolean }[]> = {
  M1: [
    { slotName: "Direction",       header: "Direction constraint candidates" },
    { slotName: "Entry Signal",    header: "Entry signal candidates" },
    { slotName: "Entry Timing",    header: "Entry timing candidates", optional: true },
    { slotName: "Regime Filter",   header: "Regime filter candidates" },
    { slotName: "Confirmation",    header: "Optional confirmation filter", optional: true },
    { slotName: "Exit",            header: "Exit candidates" },
  ],
  M2: [
    { slotName: "Band/Channel",    header: "Band/channel candidates" },
    { slotName: "Exhaustion",      header: "Exhaustion confirmation candidates" },
    { slotName: "Regime Filter",   header: "Regime filter candidates" },
    { slotName: "Exit",            header: "Exit candidates" },
  ],
  M3: [
    { slotName: "Trend Filter",    header: "Trend confirmation candidates" },
    { slotName: "Pullback Zone",   header: "Pullback zone candidates" },
    { slotName: "Pullback Confirm", header: "Pullback confirmation candidates" },
    { slotName: "Exit",            header: "Exit candidates" },
  ],
  M4: [
    { slotName: "Entry Signal",    header: "Entry signal candidates" },
    { slotName: "Regime Filter",   header: "Regime filter candidates" },
    { slotName: "Trailing Exit",   header: "Trailing exit candidates" },
  ],
};

/**
 * Parse a markdown table that starts immediately after `headerBold` and
 * extract the first column ("Approach") as candidate names plus the second
 * column as a short description.
 *
 * Expected KB format:
 * ```
 * **Header text:**
 *
 * | Approach | How it works | ... |
 * |----------|-------------|-----|
 * | Name     | Description | ... |
 * ```
 */
export function extractCandidatesFromTable(
  kbContent: string,
  headerBold: string,
): CatalogCandidate[] {
  // Find the bold header line (e.g. "**Entry signal candidates:**")
  const headerIdx = kbContent.indexOf(`**${headerBold}`);
  if (headerIdx === -1) return [];

  // Move past the header line
  const afterHeader = kbContent.indexOf("\n", headerIdx);
  if (afterHeader === -1) return [];

  const rest = kbContent.slice(afterHeader + 1);
  const lines = rest.split("\n");

  const candidates: CatalogCandidate[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines before table
    if (!inTable && trimmed === "") continue;

    // Table row detection
    if (trimmed.startsWith("|")) {
      // Skip separator rows (|---|---|...)
      if (/^\|[\s-|]+\|$/.test(trimmed)) {
        inTable = true;
        continue;
      }
      // Skip header row (first row with | Approach | ...)
      if (!inTable && /Approach/i.test(trimmed)) {
        continue;
      }

      if (inTable) {
        const cells = trimmed.split("|").map((c) => c.trim()).filter(Boolean);
        if (cells.length >= 2) {
          const candidateName = cells[0].replace(/\*\*/g, "");
          candidates.push({
            name: candidateName,
            slug: candidateToSlug(candidateName),
            description: cells[1].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").slice(0, 120),
          });
        }
      }
      continue;
    }

    // Non-table line after we were in a table = end of table
    if (inTable) break;
    // Non-table line before table started, but past header = also end
    if (trimmed !== "" && !trimmed.startsWith("|")) break;
  }

  return candidates;
}

/**
 * Extract the text of a single module section (e.g. "## 3. Module 1: Breakout"
 * through the next "---" separator). This scopes candidate table extraction
 * to avoid cross-module header collisions (e.g. "Regime filter candidates"
 * appears in multiple modules).
 */
export function extractModuleSection(kbContent: string, sectionNumber: number): string {
  const pattern = `## ${sectionNumber}. Module`;
  const start = kbContent.indexOf(pattern);
  if (start === -1) return "";

  const rest = kbContent.slice(start);
  // Find next module section or end
  const nextSection = rest.indexOf("\n---", 10);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

/**
 * Extract the variable budget table from a module section.
 * Returns a map of lowercase component name → typical vars string (e.g. "1-2").
 */
export function extractVariableBudget(sectionContent: string): Map<string, string> {
  const budget = new Map<string, string>();
  const rows = extractCandidatesFromTable(sectionContent, "Variable budget");
  for (const row of rows) {
    // name = "Entry signal", description = "1-2" (from "Typical vars" column)
    // Skip the "Typical total" summary row
    if (row.name.toLowerCase().includes("typical total")) continue;
    budget.set(row.name.toLowerCase(), row.description);
  }
  return budget;
}

/**
 * Explicit aliases mapping catalog slot names to KB variable budget component names.
 * The KB uses different naming in the budget table vs the candidate headers.
 */
const BUDGET_ALIASES: Record<string, string[]> = {
  "exit":             ["tp structure", "trailing exit", "timeout", "catastrophic stop (optional)"],
  "trailing exit":    ["tp structure", "trailing exit"],
  "entry signal":     ["trend signal (entry trigger)", "trend signal"],
  "confirmation":     ["confirmation filter", "confirmation filter (optional)"],
  "exhaustion":       ["exhaustion confirmation"],
  "pullback confirm": ["pullback confirmation"],
  "band/channel":     ["band/channel", "band"],
  "trend filter":     ["trend filter", "trend confirmation"],
  "pullback zone":    ["pullback zone", "pullback zone definition"],
};

/**
 * Match a slot name to a variable budget entry.
 */
function matchBudgetKey(slotName: string, budget: Map<string, string>): string | undefined {
  const lower = slotName.toLowerCase();
  // Direct match
  if (budget.has(lower)) return budget.get(lower);
  // Alias match
  const aliases = BUDGET_ALIASES[lower];
  if (aliases) {
    for (const alias of aliases) {
      if (budget.has(alias)) return budget.get(alias);
    }
  }
  // Partial match: slot name is contained in budget key or vice versa
  for (const [key, val] of budget) {
    if (key.includes(lower) || lower.includes(key)) return val;
  }
  return undefined;
}

/**
 * Build the full component catalog for a module by extracting all candidate
 * tables from the KB's strategy candidates section.
 */
export function extractComponentCatalog(
  kbContent: string,
  moduleId: string,
): ComponentCatalog {
  const slotDefs = MODULE_SLOT_HEADERS[moduleId];
  if (!slotDefs || !kbContent) return { slots: [] };

  // Scope extraction to this module's section to avoid cross-module collisions
  const mapping = Object.values(MODULE_MAP).find((m) => m.moduleId === moduleId);
  const sectionContent = mapping
    ? extractModuleSection(kbContent, mapping.kbSection)
    : kbContent;

  if (!sectionContent) return { slots: [] };

  const budget = extractVariableBudget(sectionContent);

  const slots: CatalogSlot[] = [];
  for (const def of slotDefs) {
    const candidates = extractCandidatesFromTable(sectionContent, def.header);
    if (candidates.length > 0) {
      const typicalVars = matchBudgetKey(def.slotName, budget);
      slots.push({ slotName: def.slotName, candidates, typicalVars, ...(def.optional ? { optional: true } : {}) });
    }
  }

  return { slots };
}

// ---------------------------------------------------------------------------
// Starting point components (KB "Recommended first iteration" → catalog slots)
// ---------------------------------------------------------------------------

/**
 * KB-aligned starting point components per module.
 * Keys are catalog slot names, values are candidate slugs.
 */
const STARTING_COMPONENTS: Record<string, Record<string, string>> = {
  M1: {
    "Direction": "both",
    "Entry Signal": "donchian",
    "Regime Filter": "ema",
    "Exit": "timeout",
  },
  M2: {
    "Band/Channel": "keltner",
    "Exhaustion": "rsi2",
    "Regime Filter": "adx-low",
    "Exit": "midline",
  },
  M3: {
    "Trend Filter": "ema",
    "Pullback Zone": "fib",
    "Pullback Confirm": "rsi-reset",
    "Exit": "swing",
  },
  M4: {
    "Entry Signal": "supertrend",
    "Regime Filter": "adx",
    "Trailing Exit": "supertrend",
  },
};

/**
 * Get the starting point components for a module (KB "Recommended first iteration").
 * Returns a slot → slug map usable with buildVariantId().
 */
export function getStartingComponents(moduleId: string): Record<string, string> {
  const components = STARTING_COMPONENTS[moduleId];
  if (!components) throw new Error(`No starting components for module: "${moduleId}"`);
  return { ...components };
}

// ---------------------------------------------------------------------------
// Starting point extraction
// ---------------------------------------------------------------------------

/**
 * Extract the "Recommended first iteration" starting point spec from a KB module section.
 * Returns the blockquote text between the header and the next bold header.
 */
export function extractStartingPoint(kbContent: string, sectionNumber: number): string {
  const section = extractModuleSection(kbContent, sectionNumber);
  if (!section) return "";

  const marker = "**Recommended first iteration";
  const startIdx = section.indexOf(marker);
  if (startIdx === -1) return "";

  const afterHeader = section.indexOf("\n", startIdx);
  if (afterHeader === -1) return "";

  const rest = section.slice(afterHeader + 1);
  const lines = rest.split("\n");
  const resultLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at next bold header or section header
    if (/^\*\*[A-Z]/.test(trimmed) || /^#{2,4}\s/.test(trimmed)) break;
    resultLines.push(line);
  }

  while (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() === "") {
    resultLines.pop();
  }

  return resultLines.join("\n").trim();
}

/**
 * Get the KB section number for a strategy profile.
 */
export function getKbSection(strategy: string): number {
  const mapping = MODULE_MAP[strategy];
  if (!mapping) throw new Error(`Unknown strategy profile: "${strategy}"`);
  return mapping.kbSection;
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
  } catch (err) {
    console.warn(`[buildModuleContext] KB not found at ${kbPath}: ${(err as Error).message}`);
  }

  if (!kbContent) {
    console.warn(`[buildModuleContext] KB content is empty — catalog will be empty, variant naming will fail`);
  }

  const fixedRules = extractFixedRules(kbContent, mapping.kbSection);
  const varCap = cfg.criteria.maxFreeVariables ?? mapping.defaultVarCap;
  const stoppingCriteria = formatStoppingCriteria(mapping.moduleId);
  const restructureLocks = cfg.paramHistory?.restructureLocks ?? "";
  const catalog = extractComponentCatalog(kbContent, mapping.moduleId);

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
    catalog,
  };
}
