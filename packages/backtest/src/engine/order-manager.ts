import type { Candle } from "../types/candle.js";
import type { Order, Fill, OrderSide } from "../types/order.js";
import { applySlippage, calculateCommission, type ExecutionConfig, DEFAULT_EXECUTION } from "./execution-model.js";

export interface PendingOrder {
  order: Order;
  entryComment: string;
}

export interface OrderCheckResult {
  fills: Fill[];
  cancelledOrderIds: string[];
}

let nextOrderId = 0;

export function createOrderId(): string {
  return `ord_${++nextOrderId}`;
}

export function resetOrderIdCounter(): void {
  nextOrderId = 0;
}

/**
 * Manages pending orders and checks them against incoming candles.
 */
export class OrderManager {
  private pendingOrders: PendingOrder[] = [];
  private execConfig: ExecutionConfig;

  constructor(execConfig: ExecutionConfig = DEFAULT_EXECUTION) {
    this.execConfig = execConfig;
  }

  addOrder(order: Order, entryComment: string): void {
    this.pendingOrders.push({ order, entryComment });
  }

  getPendingOrders(): PendingOrder[] {
    return [...this.pendingOrders];
  }

  clearOrders(): void {
    this.pendingOrders = [];
  }

  removeOrderByTag(tag: string): void {
    this.pendingOrders = this.pendingOrders.filter((po) => po.order.tag !== tag);
  }

  /**
   * Check pending orders against a candle's OHLC.
   * For same-bar SL+TP conflicts, SL wins (worst-case).
   *
   * Returns fills that triggered and cancelled order IDs.
   */
  checkOrders(candle: Candle): OrderCheckResult {
    const fills: Fill[] = [];
    const cancelledOrderIds: string[] = [];
    const triggeredIndices: Set<number> = new Set();

    // Check each pending order
    for (let i = 0; i < this.pendingOrders.length; i++) {
      const { order } = this.pendingOrders[i];

      if (order.type === "market") {
        // Market orders fill at open
        const fillPrice = applySlippage(candle.o, order.side, this.execConfig.slippageBps);
        const fee = calculateCommission(fillPrice, order.size, this.execConfig.commissionPct);
        const slippageCost = Math.abs(fillPrice - candle.o) * order.size;
        fills.push({
          orderId: order.id,
          price: fillPrice,
          size: order.size,
          side: order.side,
          fee,
          slippage: slippageCost,
          timestamp: candle.t,
          tag: order.tag,
        });
        triggeredIndices.add(i);
        continue;
      }

      if (order.type === "stop" && order.price !== null) {
        const triggered = this.isStopTriggered(order, candle);
        if (triggered) {
          const fillPrice = applySlippage(order.price, order.side, this.execConfig.slippageBps);
          const fee = calculateCommission(fillPrice, order.size, this.execConfig.commissionPct);
          const slippageCost = Math.abs(fillPrice - order.price) * order.size;
          fills.push({
            orderId: order.id,
            price: fillPrice,
            size: order.size,
            side: order.side,
            fee,
            slippage: slippageCost,
            timestamp: candle.t,
            tag: order.tag,
          });
          triggeredIndices.add(i);
        }
      }

      if (order.type === "limit" && order.price !== null) {
        const triggered = this.isLimitTriggered(order, candle);
        if (triggered) {
          // Limits fill at limit price (favorable execution)
          const fillPrice = order.price;
          const fee = calculateCommission(fillPrice, order.size, this.execConfig.commissionPct);
          fills.push({
            orderId: order.id,
            price: fillPrice,
            size: order.size,
            side: order.side,
            fee,
            slippage: 0,
            timestamp: candle.t,
            tag: order.tag,
          });
          triggeredIndices.add(i);
        }
      }
    }

    // Worst-case rule: if both SL and TP triggered on same bar, keep only SL
    const slFills = fills.filter((f) => f.tag === "sl");
    const tpFills = fills.filter((f) => f.tag.startsWith("tp"));
    if (slFills.length > 0 && tpFills.length > 0) {
      // Cancel TP fills, keep SL
      for (const tp of tpFills) {
        cancelledOrderIds.push(tp.orderId);
      }
      const validFills = fills.filter((f) => !f.tag.startsWith("tp"));
      fills.length = 0;
      fills.push(...validFills);
    }

    // Remove triggered orders from pending
    this.pendingOrders = this.pendingOrders.filter(
      (_, i) => !triggeredIndices.has(i) || cancelledOrderIds.includes(this.pendingOrders[i].order.id),
    );

    // Also remove cancelled orders from pending
    this.pendingOrders = this.pendingOrders.filter(
      (po) => !cancelledOrderIds.includes(po.order.id),
    );

    return { fills, cancelledOrderIds };
  }

  private isStopTriggered(order: Order, candle: Candle): boolean {
    if (order.price === null) return false;
    // Buy stop: triggered when price goes above stop price
    if (order.side === "buy") return candle.h >= order.price;
    // Sell stop: triggered when price goes below stop price
    return candle.l <= order.price;
  }

  private isLimitTriggered(order: Order, candle: Candle): boolean {
    if (order.price === null) return false;
    // Buy limit: triggered when price goes below limit price
    if (order.side === "buy") return candle.l <= order.price;
    // Sell limit: triggered when price goes above limit price
    return candle.h >= order.price;
  }
}
