import type { OrderIntent } from "../domain/signal-to-intent.js";

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function pctChange(entry: number, target: number): string {
  const pct = ((target - entry) / entry) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function formatOpenMessage(intent: OrderIntent, mode: string): string {
  const emoji = intent.direction === "long" ? "\u{1F7E2}" : "\u{1F534}";
  const dir = intent.direction.toUpperCase();
  const tpLines = intent.takeProfits.map(
    (tp, i) => `TP${i + 1}: ${formatUsd(tp.price)} (${pctChange(intent.entryPrice, tp.price)})`,
  );

  return [
    `${emoji} ${intent.coin} ${dir} aberto`,
    `Entry: ${formatUsd(intent.entryPrice)}`,
    `SL: ${formatUsd(intent.stopLoss)} (${pctChange(intent.entryPrice, intent.stopLoss)})`,
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
    `Entry: ${formatUsd(entryPrice)} (${pctChange(entryPrice, newLevel)} do entry)`,
    `Mode: ${mode}`,
  ].join("\n");
}
