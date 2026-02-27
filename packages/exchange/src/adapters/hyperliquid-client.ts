import { Hyperliquid } from "hyperliquid";
import { createChildLogger } from "../lib/logger.js";
import { finiteOrThrow, finiteOr, isSanePrice } from "../lib/validators.js";
import { truncateSize, truncatePrice } from "../lib/precision.js";

const log = createChildLogger("hlClient");

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
  status: "placed" | "simulated";
}

export interface HlClient {
  connect(): Promise<void>;
  getSzDecimals(coin: string): number;
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

  getSzDecimals(coin: string): number {
    return this.szDecimalsCache.get(coin) ?? 5;
  }

  /** Fetch and cache szDecimals for a coin from exchange metadata */
  async loadSzDecimals(coin: string): Promise<void> {
    if (this.szDecimalsCache.has(coin)) return;
    const t0 = performance.now();
    try {
      const meta = await this.sdk.info.perpetuals.getMeta();
      if (meta?.universe) {
        for (const asset of meta.universe) {
          this.szDecimalsCache.set(asset.name, asset.szDecimals);
        }
      }
      log.info({ action: "loadSzDecimals", coin, count: this.szDecimalsCache.size, latencyMs: Math.round(performance.now() - t0) }, "Loaded szDecimals from meta");
    } catch (err) {
      this.szDecimalsCache.set(coin, 5);
      log.warn({ action: "loadSzDecimals", coin, fallback: 5, err, latencyMs: Math.round(performance.now() - t0) }, "Meta fetch failed, using fallback szDecimals");
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
    const t0 = performance.now();
    await this.sdk.exchange.updateLeverage(sym, leverageMode, leverage);
    this.leverageCache.add(sym);
    log.info({ action: "setLeverage", coin, leverage, mode: leverageMode, latencyMs: Math.round(performance.now() - t0) }, "Leverage set");
  }

  async placeMarketOrder(coin: string, isBuy: boolean, size: number): Promise<HlOrderResult> {
    const sz = truncateSize(size, this.getSzDecimals(coin));
    if (sz <= 0) throw new Error(`Size too small after truncation: ${size} → ${sz}`);
    const t0 = performance.now();
    const result = await this.sdk.custom.marketOpen(this.toSymbol(coin), isBuy, sz);
    const orderId = extractOid(result);
    log.info({ action: "placeMarketOrder", coin, isBuy, requestedSize: size, truncatedSize: sz, orderId, latencyMs: Math.round(performance.now() - t0) }, "Market order placed");
    return { orderId, status: "placed" };
  }

  async placeStopOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    triggerPrice: number,
    reduceOnly: boolean,
  ): Promise<HlOrderResult> {
    const sz = truncateSize(size, this.getSzDecimals(coin));
    if (sz <= 0) throw new Error(`Size too small after truncation: ${size} → ${sz}`);
    const px = truncatePrice(triggerPrice);
    const t0 = performance.now();
    const result = await this.sdk.exchange.placeOrder({
      coin: this.toSymbol(coin),
      is_buy: isBuy,
      sz,
      limit_px: px,
      order_type: { trigger: { triggerPx: String(px), isMarket: true, tpsl: "sl" } },
      reduce_only: reduceOnly,
    });
    const orderId = extractOid(result);
    log.info({ action: "placeStopOrder", coin, isBuy, size: sz, triggerPrice: px, orderId, latencyMs: Math.round(performance.now() - t0) }, "Stop order placed");
    return { orderId, status: "placed" };
  }

  async placeLimitOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    reduceOnly: boolean,
  ): Promise<HlOrderResult> {
    const sz = truncateSize(size, this.getSzDecimals(coin));
    if (sz <= 0) throw new Error(`Size too small after truncation: ${size} → ${sz}`);
    const px = truncatePrice(price);
    const t0 = performance.now();
    const result = await this.sdk.exchange.placeOrder({
      coin: this.toSymbol(coin),
      is_buy: isBuy,
      sz,
      limit_px: px,
      order_type: { limit: { tif: "Gtc" } },
      reduce_only: reduceOnly,
    });
    const orderId = extractOid(result);
    log.info({ action: "placeLimitOrder", coin, isBuy, size: sz, price: px, orderId, latencyMs: Math.round(performance.now() - t0) }, "Limit order placed");
    return { orderId, status: "placed" };
  }

  async cancelOrder(coin: string, orderId: number): Promise<void> {
    const t0 = performance.now();
    await this.sdk.exchange.cancelOrder({ coin: this.toSymbol(coin), o: orderId });
    log.info({ action: "cancelOrder", coin, orderId, latencyMs: Math.round(performance.now() - t0) }, "Order cancelled");
  }

  async getPositions(walletAddress: string): Promise<HlPosition[]> {
    const t0 = performance.now();
    const state = await this.sdk.info.perpetuals.getClearinghouseState(walletAddress);
    if (!state?.assetPositions) return [];
    const positions: HlPosition[] = [];
    for (const p of state.assetPositions) {
      const szi = Number(p.position.szi);
      if (!Number.isFinite(szi) || szi === 0) continue;

      const entryPrice = Number(p.position.entryPx);
      const unrealizedPnl = Number(p.position.unrealizedPnl);
      const rawLeverage = typeof p.position.leverage === "object"
        ? (p.position.leverage as { value: number }).value
        : Number(p.position.leverage);

      try {
        finiteOrThrow(entryPrice, `${p.position.coin}.entryPx`);
        finiteOrThrow(unrealizedPnl, `${p.position.coin}.unrealizedPnl`);
      } catch (err) {
        log.warn({ action: "getPositions", coin: p.position.coin, err }, "Skipping position with invalid data");
        continue;
      }

      if (!isSanePrice(entryPrice)) {
        log.warn({ action: "getPositions", coin: p.position.coin, entryPrice }, "Skipping position with insane entry price");
        continue;
      }

      positions.push({
        coin: p.position.coin,
        direction: szi > 0 ? "long" : "short",
        size: Math.abs(szi),
        entryPrice,
        unrealizedPnl,
        leverage: finiteOr(rawLeverage, 1),
      });
    }
    log.debug({ action: "getPositions", count: positions.length, latencyMs: Math.round(performance.now() - t0) }, "Fetched positions");
    return positions;
  }

  async getOpenOrders(walletAddress: string): Promise<HlOpenOrder[]> {
    const t0 = performance.now();
    const orders = await this.sdk.info.getFrontendOpenOrders(walletAddress);
    if (!orders) return [];
    const result: HlOpenOrder[] = [];
    for (const o of orders as Array<Record<string, unknown>>) {
      const oid = Number(o.oid);
      if (!Number.isFinite(oid) || oid <= 0) {
        log.warn({ action: "getOpenOrders", rawOid: o.oid }, "Skipping order with invalid oid");
        continue;
      }
      result.push({
        coin: String(o.coin),
        oid,
        side: String(o.side),
        sz: finiteOr(Number(o.sz), 0),
        limitPx: finiteOr(Number(o.limitPx), 0),
        orderType: String(o.orderType ?? "Limit"),
        isTrigger: Boolean(o.isTrigger),
        triggerPx: finiteOr(Number(o.triggerPx ?? 0), 0),
        triggerCondition: String(o.triggerCondition ?? ""),
        reduceOnly: Boolean(o.reduceOnly),
        isPositionTpsl: Boolean(o.isPositionTpsl),
      });
    }
    log.debug({ action: "getOpenOrders", count: result.length, latencyMs: Math.round(performance.now() - t0) }, "Fetched open orders");
    return result;
  }

  async getHistoricalOrders(walletAddress: string): Promise<HlHistoricalOrder[]> {
    const t0 = performance.now();
    const orders = await this.sdk.info.getHistoricalOrders(walletAddress);
    if (!orders) return [];
    const result = (orders as unknown as Array<Record<string, unknown>>).map((o) => {
      const inner = o.order as Record<string, unknown> | undefined;
      return {
        oid: Number(inner?.oid ?? o.oid),
        status: String(o.status ?? "open") as HlHistoricalOrder["status"],
      };
    });
    log.debug({ action: "getHistoricalOrders", count: result.length, latencyMs: Math.round(performance.now() - t0) }, "Fetched historical orders");
    return result;
  }

  async getAccountEquity(walletAddress: string): Promise<number> {
    const t0 = performance.now();
    const state = await this.sdk.info.perpetuals.getClearinghouseState(walletAddress);
    if (!state?.marginSummary) return 0;
    const equity = finiteOr(Number(state.marginSummary.accountValue), 0);
    if (equity === 0 && state.marginSummary.accountValue != null) {
      log.warn({ action: "getAccountEquity", rawValue: state.marginSummary.accountValue }, "Equity parsed as invalid, returning 0");
    }
    log.debug({ action: "getAccountEquity", equity, latencyMs: Math.round(performance.now() - t0) }, "Fetched account equity");
    return equity;
  }
}
