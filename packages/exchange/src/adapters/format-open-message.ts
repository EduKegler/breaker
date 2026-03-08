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
