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
      strategy_name: null,
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

  describe("updateSignalFunding", () => {
    it("updates funding_paid on a signal row", () => {
      const sigId = store.insertSignal({
        alert_id: "fund-001",
        source: "strategy-runner",
        asset: "BTC",
        side: "LONG",
        entry_price: 95000,
        stop_loss: 94000,
        take_profits: "[]",
        risk_check_passed: 1,
        risk_check_reason: null,
        strategy_name: "donchian-adx",
      });

      store.updateSignalFunding(sigId, -5.25);

      // Insert an entry order + fill so the signal appears in position history
      store.insertOrder({
        signal_id: sigId,
        hl_order_id: null,
        coin: "BTC",
        side: "buy",
        size: 0.01,
        price: 95000,
        order_type: "market",
        tag: "entry",
        status: "filled",
        mode: "testnet",
        filled_at: "2024-01-10T10:00:00",
      });
      store.insertFill({
        order_id: 1,
        price: 95000,
        size: 0.01,
        fee: 0.5,
        timestamp: "2024-01-10T10:00:00",
      });

      const rows = store.getPositionHistoryRows(100);
      const sigRow = rows.find((r) => r.signal_id === sigId);
      expect(sigRow).toBeDefined();
      expect(sigRow!.funding_paid).toBe(-5.25);
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
        strategy_name: null,
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
        strategy_name: null,
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
        strategy_name: null,
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
        strategy_name: null,
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
        strategy_name: null,
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

  describe("getTodayGlobalTradeCount", () => {
    it("counts all passed signals across coins for today", () => {
      store.insertSignal({
        alert_id: "btc-001", source: "strategy-runner", asset: "BTC",
        side: "LONG", entry_price: 95000, stop_loss: 94000,
        take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
        strategy_name: null,
      });
      store.insertSignal({
        alert_id: "sol-001", source: "strategy-runner", asset: "SOL",
        side: "LONG", entry_price: 150, stop_loss: 145,
        take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
        strategy_name: null,
      });
      // Rejected signal should NOT count
      store.insertSignal({
        alert_id: "btc-002", source: "strategy-runner", asset: "BTC",
        side: "SHORT", entry_price: 96000, stop_loss: 97000,
        take_profits: "[]", risk_check_passed: 0, risk_check_reason: "Max positions",
        strategy_name: null,
      });

      expect(store.getTodayGlobalTradeCount()).toBe(2);
    });

    it("returns 0 when no signals today", () => {
      expect(store.getTodayGlobalTradeCount()).toBe(0);
    });
  });

  describe("getPositionHistoryRows", () => {
    function insertFullPosition(opts: { alertId: string; asset: string; side: string; strategyName: string | null; riskCheckPassed: number; entryFilled: boolean }) {
      const sigId = store.insertSignal({
        alert_id: opts.alertId, source: "strategy-runner", asset: opts.asset,
        side: opts.side, entry_price: 95000, stop_loss: 94000,
        take_profits: "[]", risk_check_passed: opts.riskCheckPassed, risk_check_reason: null,
        strategy_name: opts.strategyName,
      });
      store.insertOrder({
        signal_id: sigId, hl_order_id: null, coin: opts.asset, side: "buy",
        size: 0.01, price: 95000, order_type: "market", tag: "entry",
        status: opts.entryFilled ? "filled" : "pending", mode: "testnet",
        filled_at: opts.entryFilled ? "2024-01-10T10:00:00" : null,
      });
      if (opts.entryFilled) {
        store.insertFill({ order_id: sigId, price: 95000, size: 0.01, fee: 0.5, timestamp: "2024-01-10T10:00:00" });
        store.insertOrder({
          signal_id: sigId, hl_order_id: null, coin: opts.asset, side: "sell",
          size: 0.01, price: 94000, order_type: "stop", tag: "sl",
          status: "pending", mode: "testnet", filled_at: null,
        });
      }
      return sigId;
    }

    it("returns rows for signals with risk_check_passed=1 and entry filled", () => {
      insertFullPosition({ alertId: "ph-1", asset: "BTC", side: "LONG", strategyName: "donchian-adx", riskCheckPassed: 1, entryFilled: true });
      const rows = store.getPositionHistoryRows(100);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].signal_id).toBe(1);
      expect(rows[0].asset).toBe("BTC");
    });

    it("excludes signals with risk_check_passed=0", () => {
      insertFullPosition({ alertId: "ph-rejected", asset: "BTC", side: "LONG", strategyName: null, riskCheckPassed: 0, entryFilled: true });
      const rows = store.getPositionHistoryRows(100);
      expect(rows).toHaveLength(0);
    });

    it("excludes signals without a filled entry order", () => {
      insertFullPosition({ alertId: "ph-unfilled", asset: "BTC", side: "LONG", strategyName: null, riskCheckPassed: 1, entryFilled: false });
      const rows = store.getPositionHistoryRows(100);
      expect(rows).toHaveLength(0);
    });

    it("orders by signal_id DESC then order_id ASC", () => {
      insertFullPosition({ alertId: "ph-first", asset: "BTC", side: "LONG", strategyName: null, riskCheckPassed: 1, entryFilled: true });
      insertFullPosition({ alertId: "ph-second", asset: "ETH", side: "SHORT", strategyName: null, riskCheckPassed: 1, entryFilled: true });

      const rows = store.getPositionHistoryRows(100);
      // signal_id DESC: second signal (id=2) first
      expect(rows[0].signal_id).toBe(2);

      // Within same signal, order_id ASC
      const sig2Rows = rows.filter((r) => r.signal_id === 2);
      for (let i = 1; i < sig2Rows.length; i++) {
        expect(sig2Rows[i].order_id).toBeGreaterThanOrEqual(sig2Rows[i - 1].order_id);
      }
    });

    it("includes fill data via LEFT JOIN", () => {
      insertFullPosition({ alertId: "ph-fill", asset: "BTC", side: "LONG", strategyName: "ema-pullback", riskCheckPassed: 1, entryFilled: true });
      const rows = store.getPositionHistoryRows(100);
      const entryRow = rows.find((r) => r.tag === "entry");
      expect(entryRow).toBeDefined();
      expect(entryRow!.fill_price).toBe(95000);
      expect(entryRow!.fill_size).toBe(0.01);
      expect(entryRow!.fee).toBe(0.5);
    });

    it("respects limit parameter", () => {
      // Create 3 positions
      insertFullPosition({ alertId: "ph-l1", asset: "BTC", side: "LONG", strategyName: null, riskCheckPassed: 1, entryFilled: true });
      insertFullPosition({ alertId: "ph-l2", asset: "ETH", side: "LONG", strategyName: null, riskCheckPassed: 1, entryFilled: true });
      insertFullPosition({ alertId: "ph-l3", asset: "SOL", side: "LONG", strategyName: null, riskCheckPassed: 1, entryFilled: true });

      // With very small limit we should get fewer rows
      const rows = store.getPositionHistoryRows(2);
      expect(rows.length).toBeLessThanOrEqual(2);
    });
  });

  describe("getTodayRealizedPnl", () => {
    /**
     * Helper: insert a complete round-trip (entry + exit) with fills.
     * Entry fill timestamp is always "yesterday" unless overridden.
     * Exit fill timestamp is always "now" (today) unless overridden.
     */
    function insertRoundTrip(opts: {
      side: "LONG" | "SHORT";
      entryPrice: number;
      exitPrice: number;
      size: number;
      exitTag?: string;
      partialFills?: { price: number; size: number }[];
      fundingPaid?: number;
      exitTimestamp?: string;
      entryTimestamp?: string;
    }) {
      const sigId = store.insertSignal({
        alert_id: `pnl-${Math.random()}`,
        source: "strategy-runner",
        asset: "SOL",
        side: opts.side,
        entry_price: opts.entryPrice,
        stop_loss: opts.side === "LONG" ? opts.entryPrice - 10 : opts.entryPrice + 10,
        take_profits: "[]",
        risk_check_passed: 1,
        risk_check_reason: null,
        strategy_name: "ema-pullback",
      });

      if (opts.fundingPaid) {
        store.updateSignalFunding(sigId, opts.fundingPaid);
      }

      // Entry order + fill (yesterday by default)
      const entryOrderId = store.insertOrder({
        signal_id: sigId,
        hl_order_id: null,
        coin: "SOL",
        side: opts.side === "LONG" ? "buy" : "sell",
        size: opts.size,
        price: opts.entryPrice,
        order_type: "limit",
        tag: "entry",
        status: "filled",
        mode: "mainnet",
        filled_at: opts.entryTimestamp ?? "2020-01-01T00:00:00Z",
      });
      store.insertFill({
        order_id: entryOrderId,
        price: opts.entryPrice,
        size: opts.size,
        fee: 0,
        timestamp: opts.entryTimestamp ?? "2020-01-01T00:00:00Z",
      });

      // Exit order + fill(s) (today by default)
      const tag = opts.exitTag ?? "trailing-sl";
      const exitTs = opts.exitTimestamp ?? new Date().toISOString();

      if (opts.partialFills) {
        // Multiple partial fills on the same exit order
        const exitOrderId = store.insertOrder({
          signal_id: sigId,
          hl_order_id: null,
          coin: "SOL",
          side: opts.side === "LONG" ? "sell" : "buy",
          size: opts.size,
          price: opts.exitPrice,
          order_type: "stop",
          tag,
          status: "filled",
          mode: "mainnet",
          filled_at: exitTs,
        });
        for (const pf of opts.partialFills) {
          store.insertFill({
            order_id: exitOrderId,
            price: pf.price,
            size: pf.size,
            fee: 0,
            timestamp: exitTs,
          });
        }
      } else {
        const exitOrderId = store.insertOrder({
          signal_id: sigId,
          hl_order_id: null,
          coin: "SOL",
          side: opts.side === "LONG" ? "sell" : "buy",
          size: opts.size,
          price: opts.exitPrice,
          order_type: "stop",
          tag,
          status: "filled",
          mode: "mainnet",
          filled_at: exitTs,
        });
        store.insertFill({
          order_id: exitOrderId,
          price: opts.exitPrice,
          size: opts.size,
          fee: 0,
          timestamp: exitTs,
        });
      }
    }

    it("returns 0 when no fills today", () => {
      expect(store.getTodayRealizedPnl()).toBe(0);
    });

    it("computes profit for a LONG position closed today", () => {
      insertRoundTrip({
        side: "LONG",
        entryPrice: 85,
        exitPrice: 90,
        size: 1.0,
      });
      // PnL = (90 - 85) * 1.0 = +5
      expect(store.getTodayRealizedPnl()).toBeCloseTo(5, 4);
    });

    it("computes loss for a LONG position closed today", () => {
      insertRoundTrip({
        side: "LONG",
        entryPrice: 90,
        exitPrice: 85,
        size: 1.0,
        exitTag: "sl",
      });
      // PnL = (85 - 90) * 1.0 = -5
      expect(store.getTodayRealizedPnl()).toBeCloseTo(-5, 4);
    });

    it("computes profit for a SHORT position closed today", () => {
      insertRoundTrip({
        side: "SHORT",
        entryPrice: 90,
        exitPrice: 85,
        size: 1.0,
        exitTag: "sl",
      });
      // PnL = (90 - 85) * 1.0 = +5
      expect(store.getTodayRealizedPnl()).toBeCloseTo(5, 4);
    });

    it("computes loss for a SHORT position closed today", () => {
      insertRoundTrip({
        side: "SHORT",
        entryPrice: 85,
        exitPrice: 90,
        size: 1.0,
        exitTag: "trailing-sl",
      });
      // PnL = (85 - 90) * 1.0 = -5
      expect(store.getTodayRealizedPnl()).toBeCloseTo(-5, 4);
    });

    it("handles partial exit fills correctly (the original bug)", () => {
      // This reproduces the exact production bug: trailing-SL with 5 partial fills
      insertRoundTrip({
        side: "LONG",
        entryPrice: 85.203,
        exitPrice: 86.634, // trigger price (order price)
        size: 1.01,
        exitTag: "trailing-sl",
        partialFills: [
          { price: 86.613, size: 0.46 },
          { price: 86.611, size: 0.17 },
          { price: 86.610, size: 0.13 },
          { price: 86.608, size: 0.13 },
          { price: 86.600, size: 0.12 },
        ],
      });
      // Avg exit = (86.613*0.46 + 86.611*0.17 + 86.610*0.13 + 86.608*0.13 + 86.600*0.12) / 1.01
      // Total exit value = sum of fill_price * fill_size
      const exitValue = 86.613 * 0.46 + 86.611 * 0.17 + 86.610 * 0.13 + 86.608 * 0.13 + 86.600 * 0.12;
      const entryValue = 85.203 * 1.01;
      const expectedPnl = exitValue - entryValue; // ~+1.42
      expect(store.getTodayRealizedPnl()).toBeCloseTo(expectedPnl, 2);
      expect(store.getTodayRealizedPnl()).toBeGreaterThan(0); // must be positive!
    });

    it("ignores positions not closed today", () => {
      insertRoundTrip({
        side: "LONG",
        entryPrice: 85,
        exitPrice: 90,
        size: 1.0,
        exitTimestamp: "2020-01-01T00:00:00Z", // exit was in the past
        entryTimestamp: "2020-01-01T00:00:00Z",
      });
      expect(store.getTodayRealizedPnl()).toBe(0);
    });

    it("sums PnL across multiple positions closed today", () => {
      insertRoundTrip({ side: "LONG", entryPrice: 85, exitPrice: 90, size: 1.0 }); // +5
      insertRoundTrip({ side: "LONG", entryPrice: 100, exitPrice: 95, size: 2.0, exitTag: "sl" }); // -10
      // Total: +5 - 10 = -5
      expect(store.getTodayRealizedPnl()).toBeCloseTo(-5, 4);
    });

    it("ignores entry-only fills (open position, no exit today)", () => {
      // Only insert entry, no exit
      const sigId = store.insertSignal({
        alert_id: "open-only",
        source: "strategy-runner",
        asset: "SOL",
        side: "LONG",
        entry_price: 85,
        stop_loss: 80,
        take_profits: "[]",
        risk_check_passed: 1,
        risk_check_reason: null,
        strategy_name: null,
      });
      const orderId = store.insertOrder({
        signal_id: sigId,
        hl_order_id: null,
        coin: "SOL",
        side: "buy",
        size: 1.0,
        price: 85,
        order_type: "limit",
        tag: "entry",
        status: "filled",
        mode: "mainnet",
        filled_at: new Date().toISOString(),
      });
      store.insertFill({
        order_id: orderId,
        price: 85,
        size: 1.0,
        fee: 0,
        timestamp: new Date().toISOString(),
      });
      expect(store.getTodayRealizedPnl()).toBe(0);
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
        cumulative_funding: 0,
      });

      store.insertEquitySnapshot({
        timestamp: "2024-01-01T01:00:00Z",
        equity: 1010,
        unrealized_pnl: 15,
        realized_pnl: 0,
        open_positions: 1,
        cumulative_funding: 0,
      });

      const snapshots = store.getEquitySnapshots(100);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].equity).toBe(1010); // DESC order
    });
  });
});
