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
      "Donchian Channel + ADX + Daily EMA 200",
      "Entry ▸ Price breaks Donchian band with ADX < threshold",
      "TP ▸ No fixed TP — trailing exit via fast Donchian(20)",
      "SL ▸ ATR 1H × 2.0 (fixed stop)",
      "Timeout ▸ 5h (20 × 15m)",
    ],
  },
  "keltner-rsi2": {
    title: "Mean Reversion",
    lines: [
      "Keltner Channels + RSI(2) oversold/overbought",
      "Entry ▸ Price outside KC bands + RSI(2) extreme",
      "TP ▸ KC midline — 100% (long) / 60% (short)",
      "SL ▸ ATR 1H × 3.0 (wide catastrophic stop)",
      "Timeout ▸ 2h (8 × 15m)",
    ],
  },
  "ema-pullback": {
    title: "Trend Continuation",
    lines: [
      "EMA fast/slow crossover + 4H regime filter",
      "Entry ▸ Pullback to EMA(9), re-cross + RSI confirmation",
      "TP ▸ No fixed TP — trailing exit via EMA(9)",
      "SL ▸ ATR 1H × 2.0 (fixed stop)",
      "Timeout ▸ 7.5h (30 × 15m)",
    ],
  },
  "manual": {
    title: "Manual",
    lines: ["Signal enviado manualmente via popover"],
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
