import got, { type RequestError } from "got";
import type { OrderIntent } from "../domain/signal-to-intent.js";
import type { AlertsClient } from "../types/alerts-client.js";
import { logger } from "../lib/logger.js";
import { formatOpenMessage, formatTrailingSlMessage } from "./format-alert-message.js";

const log = logger.createChild("alertsClient");

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
