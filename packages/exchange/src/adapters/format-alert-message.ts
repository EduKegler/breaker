import { formatUsd, pctChange, formatPctChange } from "@breaker/kit";
import type { OrderIntent } from "../domain/signal-to-intent.js";

export function formatOpenMessage(intent: OrderIntent, mode: string): string {
  const emoji = intent.direction === "long" ? "\u{1F7E2}" : "\u{1F534}";
  const dir = intent.direction.toUpperCase();
  const tpLines = intent.takeProfits.map(
    (tp, i) => `TP${i + 1}: ${formatUsd(tp.price)} (${formatPctChange(pctChange(tp.price, intent.entryPrice))})`,
  );

  return [
    `${emoji} ${intent.coin} ${dir} aberto`,
    `Entry: ${formatUsd(intent.entryPrice)}`,
    `SL: ${formatUsd(intent.stopLoss)} (${formatPctChange(pctChange(intent.stopLoss, intent.entryPrice))})`,
    ...tpLines,
    `Size: ${intent.size} ${intent.coin}`,
    `Mode: ${mode}`,
  ].join("\n");
}

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
