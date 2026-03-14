const MODULE_TYPE_ABBREVIATIONS: Record<string, string> = {
  "breakout": "B",
  "mean-reversion": "MR",
  "pullback": "PB",
  "trend-following": "TF",
};

const MODULE_TYPE_LABELS: Record<string, string> = {
  "breakout": "Breakout",
  "mean-reversion": "Mean Reversion",
  "pullback": "Pullback",
  "trend-following": "Trend Following",
};

/**
 * Static fallback: strategy name → moduleType.
 * Populated from deployed manifest at build time. When the API provides
 * moduleType this map is skipped, but for components that don't have
 * access to config (history tables, position cards) it ensures the
 * abbreviation is always human-readable.
 *
 * Keep in sync with packages/backtest/src/strategies/deployed/index.ts
 */
const KNOWN_MODULE_TYPES: Record<string, string> = {
  "short-range-retest-ema-macd-partial-tp": "breakout",
  "macd-htf-adx-high-chandelier": "trend-following",
  "macd-htf-adx-high-ma-exit": "trend-following",
};

/** Resolve moduleType: explicit param > static lookup > undefined */
function resolveModuleType(strategyName: string, moduleType?: string): string | undefined {
  return moduleType ?? KNOWN_MODULE_TYPES[strategyName];
}

/** Well-known acronyms that should stay uppercased when humanizing strategy names */
const UPPERCASE_TOKENS = new Set([
  "ema", "macd", "rsi", "adx", "atr", "htf", "tp", "sl", "dc",
  "bb", "kc", "sma", "wma", "vwap", "obv", "mfi", "cci",
]);

export interface StrategyTooltipData {
  title: string;
  lines: string[];
}

/**
 * Derive abbreviation from strategy name: first letter of each hyphen-separated word.
 * E.g. "my-strategy" → "MS", "squeeze-consolidation-timeout" → "SCT"
 */
function deriveAbbreviation(name: string): string {
  return name.split("-").map((w) => w[0]?.toUpperCase() ?? "").join("");
}

export function strategyAbbr(strategyName: string, moduleType?: string): string {
  if (strategyName === "manual") return "M";
  const resolved = resolveModuleType(strategyName, moduleType);
  if (resolved && MODULE_TYPE_ABBREVIATIONS[resolved]) {
    return MODULE_TYPE_ABBREVIATIONS[resolved];
  }
  return deriveAbbreviation(strategyName) || strategyName.slice(0, 2).toUpperCase();
}

/** Full human-readable label for a moduleType (e.g. "breakout" → "Breakout") */
export function moduleTypeLabel(moduleType: string | undefined): string {
  if (!moduleType) return "Strategy";
  return MODULE_TYPE_LABELS[moduleType] ?? moduleType.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Humanize a kebab-case strategy name (e.g. "macd-htf-adx-high" → "MACD HTF ADX High") */
export function humanizeStrategyName(name: string): string {
  return name
    .split("-")
    .map((w) => UPPERCASE_TOKENS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function strategyDisplayName(strategyName: string, moduleType?: string): string {
  return `[${strategyAbbr(strategyName, moduleType)}] ${humanizeStrategyName(strategyName)}`;
}

export function strategyTooltip(strategyName: string, moduleType?: string): StrategyTooltipData {
  const resolved = resolveModuleType(strategyName, moduleType);
  const title = moduleTypeLabel(resolved);
  const humanName = humanizeStrategyName(strategyName);
  return { title, lines: [humanName] };
}

export function strategyLabel(direction: "long" | "short", strategyName: string | null | undefined, moduleType?: string): string {
  const dir = direction === "long" ? "L" : "S";
  if (!strategyName) return dir;
  return `${dir}(${strategyAbbr(strategyName, moduleType)})`;
}
