import { Hyperliquid } from "hyperliquid";

export interface HlPosition {
  coin: string;
  direction: "long" | "short";
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
}

export interface HlOpenOrder {
  coin: string;
  oid: number;
  side: string;
  sz: number;
  limitPx: number;
  orderType: string;
  isTrigger: boolean;
  triggerPx: number;
  triggerCondition: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
}

export interface HlHistoricalOrder {
  oid: number;
  status: "filled" | "open" | "canceled" | "triggered" | "rejected" | "marginCanceled";
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
  getOpenOrders(walletAddress: string): Promise<HlOpenOrder[]>;
  getHistoricalOrders(walletAddress: string): Promise<HlHistoricalOrder[]>;
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

  constructor(sdk: Hyperliquid) {
    this.sdk = sdk;
  }

  private szDecimalsCache = new Map<string, number>();

  /** SDK expects "BTC-PERP" format, domain uses plain "BTC" */
  private toSymbol(coin: string): string {
    return coin.includes("-") ? coin : `${coin}-PERP`;
  }

  /** Truncate size to exchange-allowed decimals (avoids floatToWire rounding error) */
  private truncateSize(size: number, coin: string): number {
    const decimals = this.szDecimalsCache.get(coin) ?? 5;
    const factor = 10 ** decimals;
    return Math.floor(size * factor) / factor;
  }

  /** Fetch and cache szDecimals for a coin from exchange metadata */
  async loadSzDecimals(coin: string): Promise<void> {
    if (this.szDecimalsCache.has(coin)) return;
    try {
      const meta = await this.sdk.info.perpetuals.getMeta();
      if (meta?.universe) {
        for (const asset of meta.universe) {
          this.szDecimalsCache.set(asset.name, asset.szDecimals);
        }
      }
    } catch {
      // Default to 5 decimals (BTC) if meta fetch fails
      this.szDecimalsCache.set(coin, 5);
    }
  }

  async connect(): Promise<void> {
    // No-op: SDK is connected before injection.
    // Kept for HlClient interface compatibility.
  }

  async setLeverage(coin: string, leverage: number, isCross: boolean): Promise<void> {
    const sym = this.toSymbol(coin);
    if (this.leverageCache.has(sym)) return;
    const leverageMode = isCross ? "cross" : "isolated";
    await this.sdk.exchange.updateLeverage(sym, leverageMode, leverage);
    this.leverageCache.add(sym);
  }

  async placeMarketOrder(coin: string, isBuy: boolean, size: number): Promise<HlOrderResult> {
    const sz = this.truncateSize(size, coin);
    if (sz <= 0) throw new Error(`Size too small after truncation: ${size} → ${sz}`);
    const result = await this.sdk.custom.marketOpen(this.toSymbol(coin), isBuy, sz);
    return { orderId: extractOid(result), status: "placed" };
  }

  async placeStopOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    triggerPrice: number,
    reduceOnly: boolean,
  ): Promise<HlOrderResult> {
    const sz = this.truncateSize(size, coin);
    if (sz <= 0) throw new Error(`Size too small after truncation: ${size} → ${sz}`);
    const result = await this.sdk.exchange.placeOrder({
      coin: this.toSymbol(coin),
      is_buy: isBuy,
      sz,
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
    const sz = this.truncateSize(size, coin);
    if (sz <= 0) throw new Error(`Size too small after truncation: ${size} → ${sz}`);
    const result = await this.sdk.exchange.placeOrder({
      coin: this.toSymbol(coin),
      is_buy: isBuy,
      sz,
      limit_px: price,
      order_type: { limit: { tif: "Gtc" } },
      reduce_only: reduceOnly,
    });
    return { orderId: extractOid(result), status: "placed" };
  }

  async cancelOrder(coin: string, orderId: number): Promise<void> {
    await this.sdk.exchange.cancelOrder({ coin: this.toSymbol(coin), o: orderId });
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
        direction: (Number(p.position.szi) > 0 ? "long" : "short") as "long" | "short",
        size: Math.abs(Number(p.position.szi)),
        entryPrice: Number(p.position.entryPx),
        unrealizedPnl: Number(p.position.unrealizedPnl),
        leverage: typeof p.position.leverage === "object"
          ? (p.position.leverage as { value: number }).value
          : Number(p.position.leverage),
      }));
  }

  async getOpenOrders(walletAddress: string): Promise<HlOpenOrder[]> {
    const orders = await this.sdk.info.getFrontendOpenOrders(walletAddress);
    if (!orders) return [];
    return (orders as Array<Record<string, unknown>>).map((o) => ({
      coin: String(o.coin),
      oid: Number(o.oid),
      side: String(o.side),
      sz: Number(o.sz),
      limitPx: Number(o.limitPx),
      orderType: String(o.orderType ?? "Limit"),
      isTrigger: Boolean(o.isTrigger),
      triggerPx: Number(o.triggerPx ?? 0),
      triggerCondition: String(o.triggerCondition ?? ""),
      reduceOnly: Boolean(o.reduceOnly),
      isPositionTpsl: Boolean(o.isPositionTpsl),
    }));
  }

  async getHistoricalOrders(walletAddress: string): Promise<HlHistoricalOrder[]> {
    const orders = await this.sdk.info.getHistoricalOrders(walletAddress);
    if (!orders) return [];
    return (orders as unknown as Array<Record<string, unknown>>).map((o) => {
      const inner = o.order as Record<string, unknown> | undefined;
      return {
        oid: Number(inner?.oid ?? o.oid),
        status: String(o.status ?? "open") as HlHistoricalOrder["status"],
      };
    });
  }

  async getAccountEquity(walletAddress: string): Promise<number> {
    const state = await this.sdk.info.perpetuals.getClearinghouseState(walletAddress);
    if (!state?.marginSummary) return 0;
    return Number(state.marginSummary.accountValue);
  }
}
