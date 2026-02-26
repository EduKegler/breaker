import { Hyperliquid } from "hyperliquid";

export interface HlPosition {
  coin: string;
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface HlOrderResult {
  orderId: string;
  status: string;
}

export interface HlClient {
  connect(): Promise<void>;
  setLeverage(coin: string, leverage: number, isCross: boolean): Promise<void>;
  placeMarketOrder(coin: string, isBuy: boolean, size: number): Promise<HlOrderResult>;
  placeStopOrder(coin: string, isBuy: boolean, size: number, triggerPrice: number, reduceOnly: boolean): Promise<HlOrderResult>;
  placeLimitOrder(coin: string, isBuy: boolean, size: number, price: number, reduceOnly: boolean): Promise<HlOrderResult>;
  cancelOrder(coin: string, orderId: number): Promise<void>;
  getPositions(walletAddress: string): Promise<HlPosition[]>;
  getAccountEquity(walletAddress: string): Promise<number>;
}

interface OrderResponse {
  status: string;
  response: {
    type: string;
    data: {
      statuses: Array<{
        resting?: { oid: number };
        filled?: { oid: number; totalSz: string; avgPx: string };
      }>;
    };
  };
}

function extractOid(result: unknown): string {
  const resp = result as OrderResponse | undefined;
  const status = resp?.response?.data?.statuses?.[0];
  const oid = status?.filled?.oid ?? status?.resting?.oid;
  return String(oid ?? "unknown");
}

export class HyperliquidClient implements HlClient {
  private sdk: Hyperliquid;
  private leverageCache = new Set<string>();

  constructor(privateKey: string, testnet: boolean) {
    this.sdk = new Hyperliquid({ privateKey, testnet });
  }

  async connect(): Promise<void> {
    await this.sdk.connect();
  }

  async setLeverage(coin: string, leverage: number, isCross: boolean): Promise<void> {
    if (this.leverageCache.has(coin)) return;
    const leverageMode = isCross ? "cross" : "isolated";
    await this.sdk.exchange.updateLeverage(coin, leverageMode, leverage);
    this.leverageCache.add(coin);
  }

  async placeMarketOrder(coin: string, isBuy: boolean, size: number): Promise<HlOrderResult> {
    const result = await this.sdk.custom.marketOpen(coin, isBuy, size);
    return { orderId: extractOid(result), status: "placed" };
  }

  async placeStopOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    triggerPrice: number,
    reduceOnly: boolean,
  ): Promise<HlOrderResult> {
    const result = await this.sdk.exchange.placeOrder({
      coin,
      is_buy: isBuy,
      sz: size,
      limit_px: triggerPrice,
      order_type: { trigger: { triggerPx: String(triggerPrice), isMarket: true, tpsl: "sl" } },
      reduce_only: reduceOnly,
    });
    return { orderId: extractOid(result), status: "placed" };
  }

  async placeLimitOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    reduceOnly: boolean,
  ): Promise<HlOrderResult> {
    const result = await this.sdk.exchange.placeOrder({
      coin,
      is_buy: isBuy,
      sz: size,
      limit_px: price,
      order_type: { limit: { tif: "Gtc" } },
      reduce_only: reduceOnly,
    });
    return { orderId: extractOid(result), status: "placed" };
  }

  async cancelOrder(coin: string, orderId: number): Promise<void> {
    await this.sdk.exchange.cancelOrder({ coin, o: orderId });
  }

  async getPositions(walletAddress: string): Promise<HlPosition[]> {
    const state = await this.sdk.info.perpetuals.getClearinghouseState(walletAddress);
    if (!state?.assetPositions) return [];
    return state.assetPositions
      .filter((p) => {
        const szi = Number(p.position.szi);
        return szi !== 0;
      })
      .map((p) => ({
        coin: p.position.coin,
        size: Math.abs(Number(p.position.szi)),
        entryPrice: Number(p.position.entryPx),
        unrealizedPnl: Number(p.position.unrealizedPnl),
        leverage: typeof p.position.leverage === "object"
          ? (p.position.leverage as { value: number }).value
          : Number(p.position.leverage),
      }));
  }

  async getAccountEquity(walletAddress: string): Promise<number> {
    const state = await this.sdk.info.perpetuals.getClearinghouseState(walletAddress);
    if (!state?.marginSummary) return 0;
    return Number(state.marginSummary.accountValue);
  }
}
