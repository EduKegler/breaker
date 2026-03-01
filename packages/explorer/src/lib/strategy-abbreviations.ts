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
