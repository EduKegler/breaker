const STRATEGY_ABBREVIATIONS: Record<string, string> = {
  "donchian-adx": "B",
  "keltner-rsi2": "MR",
  "ema-pullback": "PB",
  "manual": "M",
};

export function strategyAbbr(strategyName: string): string {
  return STRATEGY_ABBREVIATIONS[strategyName] ?? strategyName.slice(0, 2).toUpperCase();
}

export function strategyDisplayName(strategyName: string): string {
  return `[${strategyAbbr(strategyName)}] ${strategyName}`;
}

export function strategyLabel(direction: "long" | "short", strategyName: string | null | undefined): string {
  const dir = direction === "long" ? "L" : "S";
  if (!strategyName) return dir;
  return `${dir}(${strategyAbbr(strategyName)})`;
}
