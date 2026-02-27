import type { HlClient, HlOrderResult, HlPosition, HlOpenOrder, HlHistoricalOrder } from "./hyperliquid-client.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("dryRunClient");

export class DryRunHlClient implements HlClient {
  private counter = 0;

  getSzDecimals(_coin: string): number {
    return 5;
  }

  async connect(): Promise<void> {
    log.info({ action: "DRY_RUN", method: "connect" }, "Dry-run: connect (no-op)");
  }

  async setLeverage(coin: string, leverage: number, isCross: boolean): Promise<void> {
    log.info({ action: "DRY_RUN", method: "setLeverage", coin, leverage, isCross }, "Dry-run: setLeverage");
  }

  async placeMarketOrder(coin: string, isBuy: boolean, size: number): Promise<HlOrderResult> {
    this.counter++;
    const orderId = `dry-run-${this.counter}`;
    log.info({ action: "DRY_RUN", method: "placeMarketOrder", coin, isBuy, size, orderId }, "Dry-run: placeMarketOrder");
    return { orderId, status: "simulated" };
  }

  async placeStopOrder(coin: string, isBuy: boolean, size: number, triggerPrice: number, reduceOnly: boolean): Promise<HlOrderResult> {
    this.counter++;
    const orderId = `dry-run-${this.counter}`;
    log.info({ action: "DRY_RUN", method: "placeStopOrder", coin, isBuy, size, triggerPrice, reduceOnly, orderId }, "Dry-run: placeStopOrder");
    return { orderId, status: "simulated" };
  }

  async placeLimitOrder(coin: string, isBuy: boolean, size: number, price: number, reduceOnly: boolean): Promise<HlOrderResult> {
    this.counter++;
    const orderId = `dry-run-${this.counter}`;
    log.info({ action: "DRY_RUN", method: "placeLimitOrder", coin, isBuy, size, price, reduceOnly, orderId }, "Dry-run: placeLimitOrder");
    return { orderId, status: "simulated" };
  }

  async cancelOrder(coin: string, orderId: number): Promise<void> {
    log.info({ action: "DRY_RUN", method: "cancelOrder", coin, orderId }, "Dry-run: cancelOrder");
  }

  async getPositions(_walletAddress: string): Promise<HlPosition[]> {
    return [];
  }

  async getOpenOrders(_walletAddress: string): Promise<HlOpenOrder[]> {
    return [];
  }

  async getHistoricalOrders(_walletAddress: string): Promise<HlHistoricalOrder[]> {
    return [];
  }

  async getAccountEquity(_walletAddress: string): Promise<number> {
    return 0;
  }
}
