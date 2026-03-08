import { formatUsd, pctChange, formatPctChange } from "@breaker/kit";

export function formatTrailingSlMessage(
  coin: string,
  direction: string,
  oldLevel: number,
  newLevel: number,
  entryPrice: number,
  mode: string,
): string {
  const dir = direction.toUpperCase();
  return [
    `\u{1F6E1}\uFE0F ${coin} ${dir} trailing SL movido`,
    `${formatUsd(oldLevel)} \u2192 ${formatUsd(newLevel)}`,
    `Entry: ${formatUsd(entryPrice)} (${formatPctChange(pctChange(newLevel, entryPrice))} do entry)`,
    `Mode: ${mode}`,
  ].join("\n");
}
