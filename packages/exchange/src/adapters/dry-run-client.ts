import type { HlClient, HlOrderResult, HlEntryResult, HlPosition, HlOpenOrder, HlHistoricalOrder, HlAccountState } from "../types/hl-client.js";
import { logger } from "../lib/logger.js";

const log = logger.createChild("dryRunClient");

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

  async placeEntryOrder(coin: string, isBuy: boolean, size: number, currentPrice: number, slippageBps: number): Promise<HlEntryResult> {
    this.counter++;
    const orderId = `dry-run-${this.counter}`;
    log.info({ action: "DRY_RUN", method: "placeEntryOrder", coin, isBuy, size, currentPrice, slippageBps, orderId }, "Dry-run: placeEntryOrder");
    return { orderId, filledSize: size, avgPrice: currentPrice, status: "simulated" };
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

  async getOrderStatus(_walletAddress: string, _oid: number): Promise<HlHistoricalOrder | null> {
    return null;
  }

  async getAccountEquity(_walletAddress: string): Promise<number> {
    return 0;
  }

  async getAccountState(_walletAddress: string): Promise<HlAccountState> {
    return { accountValue: 0, totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 0, spotBalances: [] };
  }

  async getMidPrice(_coin: string): Promise<number | null> {
    return null;
  }
}
