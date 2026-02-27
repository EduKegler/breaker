import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "./sqlite-store.js";

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("SqliteStore", () => {
  describe("signals", () => {
    const signalRow = {
      alert_id: "sig-001",
      source: "strategy-runner",
      asset: "BTC",
      side: "LONG",
      entry_price: 95000,
      stop_loss: 94000,
      take_profits: JSON.stringify([{ price: 97000, pctOfPosition: 0.5 }]),
      risk_check_passed: 1,
      risk_check_reason: null,
    };

    it("inserts and checks signal existence", () => {
      const id = store.insertSignal(signalRow);
      expect(id).toBe(1);
      expect(store.hasSignal("sig-001")).toBe(true);
      expect(store.hasSignal("sig-999")).toBe(false);
    });

    it("enforces unique alert_id (idempotency)", () => {
      store.insertSignal(signalRow);
      expect(() => store.insertSignal(signalRow)).toThrow();
    });

    it("retrieves recent signals", () => {
      store.insertSignal(signalRow);
      store.insertSignal({ ...signalRow, alert_id: "sig-002" });

      const signals = store.getRecentSignals(10);
      expect(signals).toHaveLength(2);
      expect(signals[0].alert_id).toBe("sig-002"); // DESC order
    });
  });

  describe("orders", () => {
    it("inserts and retrieves orders", () => {
      store.insertSignal({
        alert_id: "sig-001",
        source: "strategy-runner",
        asset: "BTC",
        side: "LONG",
        entry_price: 95000,
        stop_loss: 94000,
        take_profits: "[]",
        risk_check_passed: 1,
        risk_check_reason: null,
      });

      const orderId = store.insertOrder({
        signal_id: 1,
        hl_order_id: null,
        coin: "BTC",
        side: "buy",
        size: 0.01,
        price: 95000,
        order_type: "market",
        tag: "entry",
        status: "pending",
        mode: "testnet",
        filled_at: null,
      });

      expect(orderId).toBe(1);

      const orders = store.getRecentOrders(10);
      expect(orders).toHaveLength(1);
      expect(orders[0].coin).toBe("BTC");
    });

    it("updates order status and HL ID", () => {
      store.insertSignal({
        alert_id: "sig-001",
        source: "api",
        asset: "BTC",
        side: "LONG",
        entry_price: 95000,
        stop_loss: 94000,
        take_profits: "[]",
        risk_check_passed: 1,
        risk_check_reason: null,
      });

      store.insertOrder({
        signal_id: 1,
        hl_order_id: null,
        coin: "BTC",
        side: "buy",
        size: 0.01,
        price: 95000,
        order_type: "market",
        tag: "entry",
        status: "pending",
        mode: "testnet",
        filled_at: null,
      });

      store.updateOrderHlId(1, "HL-12345");
      store.updateOrderStatus(1, "filled", "2024-01-01T00:00:00Z");

      const orders = store.getRecentOrders(10);
      expect(orders[0].hl_order_id).toBe("HL-12345");
      expect(orders[0].status).toBe("filled");
      expect(orders[0].filled_at).toBe("2024-01-01T00:00:00Z");
    });
  });

  describe("getPendingOrders", () => {
    it("returns only orders with pending status", () => {
      store.insertSignal({
        alert_id: "sig-001",
        source: "strategy-runner",
        asset: "BTC",
        side: "LONG",
        entry_price: 95000,
        stop_loss: 94000,
        take_profits: "[]",
        risk_check_passed: 1,
        risk_check_reason: null,
      });

      // Insert mix of orders
      store.insertOrder({
        signal_id: 1, hl_order_id: "100", coin: "BTC", side: "sell",
        size: 0.01, price: 94000, order_type: "stop", tag: "sl",
        status: "pending", mode: "testnet", filled_at: null,
      });
      store.insertOrder({
        signal_id: 1, hl_order_id: "101", coin: "BTC", side: "sell",
        size: 0.005, price: 97000, order_type: "limit", tag: "tp1",
        status: "filled", mode: "testnet", filled_at: "2024-01-01T00:00:00Z",
      });
      store.insertOrder({
        signal_id: 1, hl_order_id: "102", coin: "BTC", side: "sell",
        size: 0.005, price: 99000, order_type: "limit", tag: "tp2",
        status: "pending", mode: "testnet", filled_at: null,
      });
      store.insertOrder({
        signal_id: 1, hl_order_id: null, coin: "BTC", side: "buy",
        size: 0.01, price: 95000, order_type: "market", tag: "entry",
        status: "cancelled", mode: "testnet", filled_at: null,
      });

      const pending = store.getPendingOrders();
      expect(pending).toHaveLength(2);
      expect(pending.map((o) => o.hl_order_id)).toEqual(["100", "102"]);
    });
  });

  describe("getOrderByHlOid", () => {
    it("returns order matching hl_order_id", () => {
      store.insertSignal({
        alert_id: "sig-oid", source: "strategy-runner", asset: "BTC",
        side: "LONG", entry_price: 95000, stop_loss: 94000,
        take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      });
      store.insertOrder({
        signal_id: 1, hl_order_id: "555", coin: "BTC", side: "sell",
        size: 0.01, price: 94000, order_type: "stop", tag: "sl",
        status: "pending", mode: "testnet", filled_at: null,
      });

      const order = store.getOrderByHlOid("555");
      expect(order).not.toBeNull();
      expect(order!.hl_order_id).toBe("555");
      expect(order!.tag).toBe("sl");
    });

    it("returns null when hl_order_id not found", () => {
      expect(store.getOrderByHlOid("999")).toBeNull();
    });
  });

  describe("fills", () => {
    it("inserts fills", () => {
      store.insertSignal({
        alert_id: "sig-001",
        source: "api",
        asset: "BTC",
        side: "LONG",
        entry_price: 95000,
        stop_loss: 94000,
        take_profits: "[]",
        risk_check_passed: 1,
        risk_check_reason: null,
      });

      store.insertOrder({
        signal_id: 1,
        hl_order_id: "HL-1",
        coin: "BTC",
        side: "buy",
        size: 0.01,
        price: 95000,
        order_type: "market",
        tag: "entry",
        status: "filled",
        mode: "testnet",
        filled_at: "2024-01-01T00:00:00Z",
      });

      const fillId = store.insertFill({
        order_id: 1,
        price: 95010,
        size: 0.01,
        fee: 0.5,
        timestamp: "2024-01-01T00:00:00Z",
      });

      expect(fillId).toBe(1);
    });
  });

  describe("equity snapshots", () => {
    it("inserts and retrieves equity snapshots", () => {
      store.insertEquitySnapshot({
        timestamp: "2024-01-01T00:00:00Z",
        equity: 1000,
        unrealized_pnl: 5,
        realized_pnl: 0,
        open_positions: 1,
      });

      store.insertEquitySnapshot({
        timestamp: "2024-01-01T01:00:00Z",
        equity: 1010,
        unrealized_pnl: 15,
        realized_pnl: 0,
        open_positions: 1,
      });

      const snapshots = store.getEquitySnapshots(100);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].equity).toBe(1010); // DESC order
    });
  });
});
