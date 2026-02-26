import { describe, it, expect, beforeEach } from "vitest";
import { OrderManager, createOrderId, resetOrderIdCounter } from "./order-manager.js";
import type { Order } from "../types/order.js";
import type { Candle } from "../types/candle.js";

function makeCandle(o: number, h: number, l: number, c: number, t = 1000): Candle {
  return { t, o, h, l, c, v: 0, n: 0 };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: createOrderId(),
    side: "buy",
    type: "market",
    price: null,
    size: 1,
    reduceOnly: false,
    tag: "entry",
    ...overrides,
  };
}

describe("OrderManager", () => {
  beforeEach(() => {
    resetOrderIdCounter();
  });

  it("fills market orders at candle open with slippage", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0 });
    om.addOrder(makeOrder({ type: "market", side: "buy" }), "test");
    const candle = makeCandle(100, 110, 90, 105);
    const result = om.checkOrders(candle);

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].price).toBe(100); // open price, no slippage
    expect(om.getPendingOrders()).toHaveLength(0);
  });

  it("fills sell stop when low touches stop price", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0 });
    om.addOrder(
      makeOrder({ type: "stop", side: "sell", price: 95, tag: "sl" }),
      "test",
    );
    const candle = makeCandle(100, 105, 94, 96);
    const result = om.checkOrders(candle);

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].tag).toBe("sl");
    expect(result.fills[0].price).toBe(95);
  });

  it("does not fill sell stop when low stays above price", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0 });
    om.addOrder(
      makeOrder({ type: "stop", side: "sell", price: 90, tag: "sl" }),
      "test",
    );
    const candle = makeCandle(100, 105, 91, 102);
    const result = om.checkOrders(candle);

    expect(result.fills).toHaveLength(0);
    expect(om.getPendingOrders()).toHaveLength(1);
  });

  it("fills buy stop when high touches stop price", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0 });
    om.addOrder(
      makeOrder({ type: "stop", side: "buy", price: 110, tag: "entry" }),
      "test",
    );
    const candle = makeCandle(100, 112, 98, 108);
    const result = om.checkOrders(candle);

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].price).toBe(110);
  });

  it("fills buy limit when low touches limit price", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0 });
    om.addOrder(
      makeOrder({ type: "limit", side: "buy", price: 95, tag: "entry" }),
      "test",
    );
    const candle = makeCandle(100, 105, 93, 98);
    const result = om.checkOrders(candle);

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].price).toBe(95); // limit = no slippage
  });

  it("fills sell limit when high touches limit price", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0 });
    om.addOrder(
      makeOrder({ type: "limit", side: "sell", price: 110, tag: "tp1" }),
      "test",
    );
    const candle = makeCandle(100, 112, 98, 105);
    const result = om.checkOrders(candle);

    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].price).toBe(110);
  });

  it("SL wins when both SL and TP trigger on same bar", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0 });
    om.addOrder(
      makeOrder({ type: "stop", side: "sell", price: 90, tag: "sl", size: 1 }),
      "test",
    );
    om.addOrder(
      makeOrder({ type: "limit", side: "sell", price: 120, tag: "tp1", size: 1 }),
      "test",
    );
    // Wide bar that hits both SL and TP
    const candle = makeCandle(100, 125, 85, 110);
    const result = om.checkOrders(candle);

    // Only SL fill should remain
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].tag).toBe("sl");
    expect(result.cancelledOrderIds).toHaveLength(1);
  });

  it("applies slippage on stop fills", () => {
    const om = new OrderManager({ slippageBps: 10, commissionPct: 0 }); // 10 bps = 0.1%
    om.addOrder(
      makeOrder({ type: "stop", side: "sell", price: 100, tag: "sl" }),
      "test",
    );
    const candle = makeCandle(105, 107, 95, 98);
    const result = om.checkOrders(candle);

    // Sell stop at 100, slippage down: 100 * (1 - 0.001) = 99.9
    expect(result.fills[0].price).toBeCloseTo(99.9, 2);
  });

  it("calculates commission on fills", () => {
    const om = new OrderManager({ slippageBps: 0, commissionPct: 0.1 }); // 0.1%
    om.addOrder(
      makeOrder({ type: "market", side: "buy", size: 2 }),
      "test",
    );
    const candle = makeCandle(1000, 1100, 900, 1050);
    const result = om.checkOrders(candle);

    // Notional = 1000 * 2 = 2000, commission = 2000 * 0.001 = 2
    expect(result.fills[0].fee).toBeCloseTo(2, 5);
  });

  it("clearOrders removes all pending", () => {
    const om = new OrderManager();
    om.addOrder(makeOrder(), "test");
    om.addOrder(makeOrder(), "test");
    om.clearOrders();
    expect(om.getPendingOrders()).toHaveLength(0);
  });

  it("removeOrderByTag removes matching orders", () => {
    const om = new OrderManager();
    om.addOrder(makeOrder({ tag: "sl" }), "test");
    om.addOrder(makeOrder({ tag: "tp1" }), "test");
    om.removeOrderByTag("sl");
    expect(om.getPendingOrders()).toHaveLength(1);
    expect(om.getPendingOrders()[0].order.tag).toBe("tp1");
  });
});
