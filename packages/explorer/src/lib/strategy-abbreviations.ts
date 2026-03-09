const MODULE_TYPE_ABBREVIATIONS: Record<string, string> = {
  "breakout": "B",
  "mean-reversion": "MR",
  "pullback": "PB",
  "trend-following": "TF",
};

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
  if (moduleType && MODULE_TYPE_ABBREVIATIONS[moduleType]) {
    return MODULE_TYPE_ABBREVIATIONS[moduleType];
  }
  return deriveAbbreviation(strategyName) || strategyName.slice(0, 2).toUpperCase();
}

export function strategyDisplayName(strategyName: string, moduleType?: string): string {
  return `[${strategyAbbr(strategyName, moduleType)}] ${strategyName}`;
}

export function strategyTooltip(strategyName: string): StrategyTooltipData {
  return { title: strategyName, lines: [] };
}

export function strategyLabel(direction: "long" | "short", strategyName: string | null | undefined, moduleType?: string): string {
  const dir = direction === "long" ? "L" : "S";
  if (!strategyName) return dir;
  return `${dir}(${strategyAbbr(strategyName, moduleType)})`;
}
