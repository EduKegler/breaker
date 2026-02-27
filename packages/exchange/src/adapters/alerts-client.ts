import got, { type RequestError } from "got";
import type { OrderIntent } from "../domain/order-intent.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("alertsClient");

function networkErrorContext(err: unknown): Record<string, unknown> {
  const re = err as RequestError;
  return {
    err,
    endpoint: re.options?.url?.toString(),
    method: re.options?.method,
    statusCode: re.response?.statusCode,
    responseBody: typeof re.response?.body === "string" ? re.response.body.slice(0, 200) : undefined,
    code: re.code,
  };
}

export interface AlertsClient {
  notifyPositionOpened(intent: OrderIntent, mode: string): Promise<void>;
  notifyTrailingSlMoved(coin: string, direction: string, oldLevel: number, newLevel: number, entryPrice: number, mode: string): Promise<void>;
  sendText(text: string): Promise<void>;
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

export class HttpAlertsClient implements AlertsClient {
  private gatewayUrl: string;

  constructor(gatewayUrl: string) {
    this.gatewayUrl = gatewayUrl;
  }

  async notifyPositionOpened(intent: OrderIntent, mode: string): Promise<void> {
    const text = formatOpenMessage(intent, mode);
    const t0 = performance.now();
    try {
      await got.post(this.gatewayUrl, {
        json: { text },
        timeout: { request: 10_000 },
        retry: { limit: 1 },
      });
      log.info({ action: "notifyPositionOpened", coin: intent.coin, direction: intent.direction, latencyMs: Math.round(performance.now() - t0) }, "Position opened notification sent");
    } catch (err) {
      log.warn({ action: "notifyPositionOpened", coin: intent.coin, latencyMs: Math.round(performance.now() - t0), ...networkErrorContext(err) }, "Position opened notification failed");
      throw err;
    }
  }

  async sendText(text: string): Promise<void> {
    const t0 = performance.now();
    try {
      await got.post(this.gatewayUrl, {
        json: { text },
        timeout: { request: 10_000 },
        retry: { limit: 1 },
      });
      log.info({ action: "sendText", latencyMs: Math.round(performance.now() - t0) }, "Alert sent");
    } catch (err) {
      log.warn({ action: "sendText", latencyMs: Math.round(performance.now() - t0), ...networkErrorContext(err) }, "Alert send failed");
      throw err;
    }
  }

  async notifyTrailingSlMoved(
    coin: string,
    direction: string,
    oldLevel: number,
    newLevel: number,
    entryPrice: number,
    mode: string,
  ): Promise<void> {
    const text = formatTrailingSlMessage(coin, direction, oldLevel, newLevel, entryPrice, mode);
    const t0 = performance.now();
    try {
      await got.post(this.gatewayUrl, {
        json: { text },
        timeout: { request: 10_000 },
        retry: { limit: 1 },
      });
      log.info({ action: "notifyTrailingSlMoved", coin, oldLevel, newLevel, latencyMs: Math.round(performance.now() - t0) }, "Trailing SL notification sent");
    } catch (err) {
      log.warn({ action: "notifyTrailingSlMoved", coin, latencyMs: Math.round(performance.now() - t0), ...networkErrorContext(err) }, "Trailing SL notification failed");
      throw err;
    }
  }
}
