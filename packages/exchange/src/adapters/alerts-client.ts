import got from "got";
import type { OrderIntent } from "../domain/order-intent.js";

export interface AlertsClient {
  notifyPositionOpened(intent: OrderIntent, mode: string): Promise<void>;
}

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

export class HttpAlertsClient implements AlertsClient {
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  async notifyPositionOpened(intent: OrderIntent, mode: string): Promise<void> {
    const text = formatOpenMessage(intent, mode);
    await got.post(`${this.gatewayUrl}/send`, {
      json: { text },
      timeout: { request: 10_000 },
      retry: { limit: 1 },
    });
  }
}
