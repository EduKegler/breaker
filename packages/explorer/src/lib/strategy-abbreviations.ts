const STRATEGY_ABBREVIATIONS: Record<string, string> = {
  "donchian-adx": "B",
  "keltner-rsi2": "MR",
  "ema-pullback": "PB",
  "manual": "M",
};

export interface StrategyTooltipData {
  title: string;
  lines: string[];
}

const STRATEGY_TOOLTIPS: Record<string, StrategyTooltipData> = {
  "donchian-adx": {
    title: "Breakout",
    lines: [
      "Donchian Channel + ADX + Daily EMA regime",
      "Entry ▸ price breaks DC when ADX < threshold",
      "Exit ▸ trailing fast Donchian (sem TP fixo)",
      "Risk ▸ SL ATR 1H × mult · timeout",
    ],
  },
  "keltner-rsi2": {
    title: "Mean Reversion",
    lines: [
      "Keltner Channels + RSI(2)",
      "Entry ▸ price fora das bandas KC + RSI(2) extremo",
      "  shorts exigem volume spike > 1.5× avg",
      "Exit ▸ TP no KC mid: 100% long / 60% short",
      "Risk ▸ SL ATR 1H × mult · timeout",
    ],
  },
  "ema-pullback": {
    title: "Trend Continuation",
    lines: [
      "EMA Pullback + regime 4H",
      "Entry ▸ pullback na EMA rápida, re-cross + RSI",
      "Exit ▸ trailing EMA rápida (sem TP fixo)",
      "Risk ▸ SL ATR 1H × mult · timeout",
    ],
  },
  "manual": {
    title: "Manual",
    lines: ["Signal enviado via popover"],
  },
};

export function strategyAbbr(strategyName: string): string {
  return STRATEGY_ABBREVIATIONS[strategyName] ?? strategyName.slice(0, 2).toUpperCase();
}

export function strategyDisplayName(strategyName: string): string {
  return `[${strategyAbbr(strategyName)}] ${strategyName}`;
}

export function strategyTooltip(strategyName: string): StrategyTooltipData {
  return STRATEGY_TOOLTIPS[strategyName] ?? { title: strategyName, lines: [] };
}

export function strategyLabel(direction: "long" | "short", strategyName: string | null | undefined): string {
  const dir = direction === "long" ? "L" : "S";
  if (!strategyName) return dir;
  return `${dir}(${strategyAbbr(strategyName)})`;
}
