import type { Hyperliquid } from "hyperliquid";
import { logger } from "../lib/logger.js";
import type { WsOrder, WsUserFill, HlEventStreamCallbacks } from "../types/hl-event-stream.js";

const log = logger.createChild("hlEventStream");

export class HlEventStream {
  private sdk: Hyperliquid;
  private walletAddress: string;
  private started = false;

  constructor(sdk: Hyperliquid, walletAddress: string) {
    this.sdk = sdk;
    this.walletAddress = walletAddress;
  }

  async start(callbacks: HlEventStreamCallbacks): Promise<void> {
    this.started = true;
    log.info({ action: "start" }, "Subscribing to HL events");

    // The SDK auto-reconnects and re-subscribes (via resubscribeAll), but fills
    // that occur during the disconnect window are lost — the fill snapshot sent
    // on reconnect is intentionally ignored (isSnapshot guard).  Hook into the
    // SDK's "reconnect" event to trigger an immediate REST-based sync so the
    // daemon catches up on any missed state changes.
    const ws = this.sdk.ws as { on?: (event: string, cb: (...args: unknown[]) => void) => void };
    if (ws && typeof ws.on === "function") {
      ws.on("reconnect", () => {
        if (!this.started) return;
        log.warn({ action: "wsReconnected" }, "WebSocket reconnected — triggering position sync");
        try {
          callbacks.onReconnected?.();
        } catch (err) {
          log.error({ action: "onReconnected", err }, "Callback error in reconnect handler");
        }
      });

      ws.on("close", (...args: unknown[]) => {
        if (!this.started) return;
        const code = typeof args[0] === "number" ? args[0] : 0;
        const reason = typeof args[1] === "string" ? args[1] : "";
        log.warn({ action: "wsDisconnected", code, reason }, "WebSocket disconnected");
        try {
          callbacks.onDisconnected?.(code, reason);
        } catch (err) {
          log.error({ action: "onDisconnected", err }, "Callback error in close handler");
        }
      });

      ws.on("maxReconnectAttemptsReached", () => {
        if (!this.started) return;
        log.error({ action: "wsMaxReconnectFailed" }, "WebSocket max reconnect attempts reached — stream is DEAD");
        try {
          callbacks.onMaxReconnectFailed?.();
        } catch (err) {
          log.error({ action: "onMaxReconnectFailed", err }, "Callback error in maxReconnectAttemptsReached handler");
        }
      });
    } else {
      log.warn({ action: "noReconnectHook" }, "SDK ws.on('reconnect') not available — missed events will only be caught by reconcile loop");
    }

    try {
      await this.sdk.subscriptions.subscribeToOrderUpdates(
        this.walletAddress,
        (orders: WsOrder[]) => {
          if (!this.started) return;
          try {
            callbacks.onOrderUpdate(orders);
          } catch (err) {
            log.error({ action: "onOrderUpdate", err }, "Callback error in order update handler");
          }
        },
      );
      log.info({ action: "subscribed", channel: "orderUpdates" }, "Subscribed to order updates");

      await this.sdk.subscriptions.subscribeToUserFills(
        this.walletAddress,
        (data: { isSnapshot: boolean; fills: WsUserFill[] }) => {
          if (!this.started) return;
          try {
            callbacks.onFill(data.fills, data.isSnapshot);
          } catch (err) {
            log.error({ action: "onFill", err }, "Callback error in fill handler");
          }
        },
      );
      log.info({ action: "subscribed", channel: "userFills" }, "Subscribed to user fills");
    } catch (err) {
      log.error({ action: "subscriptionFailed", err }, "Failed to subscribe to HL events");
      throw err;
    }
  }

  stop(): void {
    this.started = false;
    log.info({ action: "stop" }, "HL event stream stopped");
  }
}
