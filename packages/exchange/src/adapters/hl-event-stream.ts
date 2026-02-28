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
  }

  stop(): void {
    this.started = false;
    log.info({ action: "stop" }, "HL event stream stopped");
  }
}
