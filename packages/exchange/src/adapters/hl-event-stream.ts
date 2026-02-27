import type { Hyperliquid } from "hyperliquid";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("hlEventStream");

export interface WsOrder {
  order: {
    coin: string;
    side: string;
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    origSz: string;
  };
  status: string;
  statusTimestamp: number;
  user: string;
}

export interface WsUserFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
}

export interface HlEventStreamCallbacks {
  onOrderUpdate: (orders: WsOrder[]) => void;
  onFill: (fills: WsUserFill[], isSnapshot: boolean) => void;
}

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
