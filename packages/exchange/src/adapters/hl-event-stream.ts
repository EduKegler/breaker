import type { Hyperliquid } from "hyperliquid";

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

    await this.sdk.subscriptions.subscribeToOrderUpdates(
      this.walletAddress,
      (orders: WsOrder[]) => {
        callbacks.onOrderUpdate(orders);
      },
    );

    await this.sdk.subscriptions.subscribeToUserFills(
      this.walletAddress,
      (data: { isSnapshot: boolean; fills: WsUserFill[] }) => {
        callbacks.onFill(data.fills, data.isSnapshot);
      },
    );
  }

  stop(): void {
    this.started = false;
  }
}
