import { describe, it, expect, vi, beforeEach } from "vitest";
import { placeProtectionOrders, type ProtectionOrdersInput, type ProtectionOrdersDeps } from "./place-protection-orders.js";
import { PositionBook } from "../domain/position-book.js";
import { SqliteStore } from "../adapters/sqlite-store.js";
import type { HlClient } from "../types/hl-client.js";
import type { EventLog } from "../adapters/event-log.js";

function createMockHlClient(): HlClient {
  return {
    connect: vi.fn(),
    getSzDecimals: vi.fn().mockReturnValue(5),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-MKT1", status: "placed" }),
    placeEntryOrder: vi.fn(),
    placeGtcEntryOrder: vi.fn(),
    placeStopOrder: vi.fn().mockResolvedValue({ orderId: "HL-SL1", status: "placed" }),
    placeLimitOrder: vi.fn(),
    placeTpOrder: vi.fn().mockResolvedValue({ orderId: "HL-TP1", status: "placed" }),
    cancelOrder: vi.fn(),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getHistoricalOrders: vi.fn().mockResolvedValue([]),
    getOrderStatus: vi.fn().mockResolvedValue(null),
    getAccountEquity: vi.fn().mockResolvedValue(1000),
    getAccountState: vi.fn().mockResolvedValue({ accountValue: 0, totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 0, spotBalances: [] }),
    getMidPrice: vi.fn().mockResolvedValue(null),
  };
}

/** Insert a parent signal row so that order FK constraint is satisfied. */
function insertParentSignal(store: SqliteStore): number {
  return store.insertSignal({
    alert_id: `test-${Date.now()}-${Math.random()}`,
    source: "strategy-runner",
    asset: "BTC",
    side: "LONG",
    entry_price: 60000,
    stop_loss: 59000,
    take_profits: "[]",
    risk_check_passed: 1,
    risk_check_reason: null,
    strategy_name: null,
  });
}

function makeInput(store: SqliteStore, overrides: Partial<ProtectionOrdersInput> = {}): ProtectionOrdersInput {
  const signalId = overrides.signalId ?? insertParentSignal(store);
  return {
    coin: "BTC",
    signalId,
    direction: "long",
    entrySide: "buy",
    actualSize: 0.01,
    actualPrice: 60000,
    stopLoss: 59000,
    takeProfits: [{ price: 62000, pctOfPosition: 1 }],
    leverage: 5,
    mode: "testnet",
    strategyName: "test-strat",
    szDecimals: 5,
    ...overrides,
    // Ensure signalId is not overridden by the spread if it was computed above
  };
}

describe("placeProtectionOrders", () => {
  let hlClient: HlClient;
  let store: SqliteStore;
  let eventLog: EventLog;
  let positionBook: PositionBook;
  let deps: ProtectionOrdersDeps;

  beforeEach(() => {
    hlClient = createMockHlClient();
    store = new SqliteStore(":memory:");
    eventLog = { append: vi.fn() } as unknown as EventLog;
    positionBook = new PositionBook();
    deps = { hlClient, store, eventLog, positionBook };
  });

  describe("happy path", () => {
    it("places SL and single TP, opens position in book", async () => {
      const input = makeInput(store);
      await placeProtectionOrders(input, deps);

      // SL placed with correct args: opposite side to entry (entrySide=buy -> isBuy=false=sell)
      expect(hlClient.placeStopOrder).toHaveBeenCalledWith("BTC", false, 0.01, 59000, true);

      // TP placed with correct args
      expect(hlClient.placeTpOrder).toHaveBeenCalledWith("BTC", false, 0.01, 62000, true);

      // SL order persisted in store
      const orders = store.getRecentOrders(10);
      const slOrder = orders.find((o) => o.tag === "sl");
      expect(slOrder).toBeDefined();
      expect(slOrder!.order_type).toBe("stop");
      expect(slOrder!.status).toBe("pending");

      // TP order persisted
      const tpOrder = orders.find((o) => o.tag === "tp1");
      expect(tpOrder).toBeDefined();
      expect(tpOrder!.order_type).toBe("trigger");

      // Position opened in book
      expect(positionBook.isFlat("BTC")).toBe(false);
      const pos = positionBook.get("BTC")!;
      expect(pos.direction).toBe("long");
      expect(pos.size).toBe(0.01);
      expect(pos.stopLoss).toBe(59000);
      expect(pos.entryPrice).toBe(60000);
    });

    it("places SL and TP for short direction", async () => {
      const input = makeInput(store, {
        direction: "short",
        entrySide: "sell",
        stopLoss: 61000,
        takeProfits: [{ price: 58000, pctOfPosition: 1 }],
      });
      await placeProtectionOrders(input, deps);

      // Short entry -> entrySide=sell -> isBuy for SL = true (sell opposite = buy)
      expect(hlClient.placeStopOrder).toHaveBeenCalledWith("BTC", true, 0.01, 61000, true);
      expect(hlClient.placeTpOrder).toHaveBeenCalledWith("BTC", true, 0.01, 58000, true);

      const pos = positionBook.get("BTC")!;
      expect(pos.direction).toBe("short");
    });
  });

  describe("multiple take profits", () => {
    it("places multiple TP orders with correct sizes", async () => {
      vi.mocked(hlClient.placeTpOrder)
        .mockResolvedValueOnce({ orderId: "HL-TP1", status: "placed" })
        .mockResolvedValueOnce({ orderId: "HL-TP2", status: "placed" });

      const input = makeInput(store, {
        actualSize: 0.1,
        takeProfits: [
          { price: 62000, pctOfPosition: 0.5 },
          { price: 64000, pctOfPosition: 0.5 },
        ],
      });
      await placeProtectionOrders(input, deps);

      expect(hlClient.placeTpOrder).toHaveBeenCalledTimes(2);

      // Last TP gets the remainder (actualSize - allocated so far)
      const tp1Call = vi.mocked(hlClient.placeTpOrder).mock.calls[0];
      const tp2Call = vi.mocked(hlClient.placeTpOrder).mock.calls[1];
      expect(tp1Call[2] + tp2Call[2]).toBe(0.1);

      const orders = store.getRecentOrders(10);
      expect(orders.filter((o) => o.tag.startsWith("tp"))).toHaveLength(2);
    });

    it("last TP gets remainder when fractions sum to 100%", async () => {
      vi.mocked(hlClient.placeTpOrder)
        .mockResolvedValueOnce({ orderId: "HL-TP1", status: "placed" })
        .mockResolvedValueOnce({ orderId: "HL-TP2", status: "placed" });

      // Use sizes where truncation still results in cumulativePct >= 1
      // actualSize=0.1, szDecimals=5: tp1=0.5*0.1=0.05, tp2 remainder=0.05
      const input = makeInput(store, {
        actualSize: 0.1,
        szDecimals: 5,
        takeProfits: [
          { price: 62000, pctOfPosition: 0.5 },
          { price: 64000, pctOfPosition: 0.5 },
        ],
      });
      await placeProtectionOrders(input, deps);

      const calls = vi.mocked(hlClient.placeTpOrder).mock.calls;
      // Last TP should use actualSize - allocatedTpSize = remainder
      const tp2Size = calls[1][2];
      expect(tp2Size).toBe(0.05); // remainder, not truncated independently
      expect(calls[0][2] + tp2Size).toBe(0.1);
    });
  });

  describe("SL failure -- rollback via market close", () => {
    it("rolls back entry by closing position when SL placement fails", async () => {
      const slError = new Error("SL placement failed");
      vi.mocked(hlClient.placeStopOrder).mockRejectedValueOnce(slError);

      const input = makeInput(store);
      await expect(placeProtectionOrders(input, deps)).rejects.toThrow("SL placement failed");

      // Market close called to rollback: entrySide=buy -> opposite=sell (isBuy=false)
      expect(hlClient.placeMarketOrder).toHaveBeenCalledWith("BTC", false, 0.01);

      // No TP should have been placed
      expect(hlClient.placeTpOrder).not.toHaveBeenCalled();

      // Position should NOT be in book (successfully rolled back)
      expect(positionBook.isFlat("BTC")).toBe(true);
    });

    it("hydrates position in book when both SL and market close fail", async () => {
      vi.mocked(hlClient.placeStopOrder).mockRejectedValueOnce(new Error("SL failed"));
      vi.mocked(hlClient.placeMarketOrder).mockRejectedValueOnce(new Error("Close failed"));

      const input = makeInput(store);
      await expect(placeProtectionOrders(input, deps)).rejects.toThrow("SL failed");

      // Position hydrated with stopLoss=0 (stuck on HL without SL)
      expect(positionBook.isFlat("BTC")).toBe(false);
      const pos = positionBook.get("BTC")!;
      expect(pos.stopLoss).toBe(0);
      expect(pos.direction).toBe("long");
      expect(pos.entryPrice).toBe(60000);
      expect(pos.size).toBe(0.01);
    });

    it("closes existing position before hydrating on rollback failure", async () => {
      // Pre-existing position (e.g. from reconcile)
      positionBook.open({
        coin: "BTC", direction: "long", entryPrice: 55000, size: 0.005,
        stopLoss: 54000, takeProfits: [], liquidationPx: null,
        trailingStopLoss: null, leverage: 5, openedAt: new Date().toISOString(),
        signalId: 0, strategyName: null,
      });

      vi.mocked(hlClient.placeStopOrder).mockRejectedValueOnce(new Error("SL failed"));
      vi.mocked(hlClient.placeMarketOrder).mockRejectedValueOnce(new Error("Close failed"));

      const input = makeInput(store);
      await expect(placeProtectionOrders(input, deps)).rejects.toThrow("SL failed");

      // Old position closed and new one hydrated
      const pos = positionBook.get("BTC")!;
      expect(pos.entryPrice).toBe(60000);
      expect(pos.stopLoss).toBe(0);
    });
  });

  describe("TP failure (non-critical)", () => {
    it("position remains protected by SL when TP placement fails", async () => {
      vi.mocked(hlClient.placeTpOrder).mockRejectedValueOnce(new Error("TP failed"));

      const input = makeInput(store);
      await placeProtectionOrders(input, deps);

      // SL was still placed
      expect(hlClient.placeStopOrder).toHaveBeenCalled();

      // Position opened despite TP failure
      expect(positionBook.isFlat("BTC")).toBe(false);
      const pos = positionBook.get("BTC")!;
      expect(pos.stopLoss).toBe(59000);

      // SL order in store, TP order not (failed)
      const orders = store.getRecentOrders(10);
      expect(orders.find((o) => o.tag === "sl")).toBeDefined();
      expect(orders.find((o) => o.tag === "tp1")).toBeUndefined();
    });

    it("continues placing remaining TPs after one fails", async () => {
      vi.mocked(hlClient.placeTpOrder)
        .mockRejectedValueOnce(new Error("TP1 failed"))
        .mockResolvedValueOnce({ orderId: "HL-TP2", status: "placed" });

      const input = makeInput(store, {
        takeProfits: [
          { price: 62000, pctOfPosition: 0.5 },
          { price: 64000, pctOfPosition: 0.5 },
        ],
      });
      await placeProtectionOrders(input, deps);

      // Both TPs attempted
      expect(hlClient.placeTpOrder).toHaveBeenCalledTimes(2);

      // Only tp2 persisted in store
      const orders = store.getRecentOrders(10);
      expect(orders.find((o) => o.tag === "tp1")).toBeUndefined();
      expect(orders.find((o) => o.tag === "tp2")).toBeDefined();
    });
  });

  describe("position book race condition", () => {
    it("replaces stale hydrated position with accurate data", async () => {
      // Simulate reconcile loop hydrating a stale position before protection orders
      positionBook.open({
        coin: "BTC", direction: "long", entryPrice: 60000, size: 0.01,
        stopLoss: 0, takeProfits: [], liquidationPx: null,
        trailingStopLoss: null, leverage: 5, openedAt: new Date().toISOString(),
        signalId: 1, strategyName: null,
      });

      const input = makeInput(store);
      await placeProtectionOrders(input, deps);

      // Position replaced with accurate SL/TP data
      const pos = positionBook.get("BTC")!;
      expect(pos.stopLoss).toBe(59000);
      expect(pos.takeProfits).toEqual([{ price: 62000, pctOfPosition: 1 }]);
      expect(pos.strategyName).toBe("test-strat");
    });
  });

  describe("store persistence", () => {
    it("inserts SL order with correct fields", async () => {
      const signalId = insertParentSignal(store);

      const input = makeInput(store, { signalId });
      await placeProtectionOrders(input, deps);

      const orders = store.getRecentOrders(10);
      const slOrder = orders.find((o) => o.tag === "sl")!;
      expect(slOrder.signal_id).toBe(signalId);
      expect(slOrder.hl_order_id).toBe("HL-SL1");
      expect(slOrder.coin).toBe("BTC");
      expect(slOrder.side).toBe("sell"); // opposite of buy entry
      expect(slOrder.size).toBe(0.01);
      expect(slOrder.price).toBe(59000);
      expect(slOrder.order_type).toBe("stop");
      expect(slOrder.mode).toBe("testnet");
    });

    it("inserts TP order with trigger type and correct tag", async () => {
      const input = makeInput(store);
      await placeProtectionOrders(input, deps);

      const orders = store.getRecentOrders(10);
      const tpOrder = orders.find((o) => o.tag === "tp1")!;
      expect(tpOrder.order_type).toBe("trigger");
      expect(tpOrder.side).toBe("sell"); // opposite of buy entry
    });
  });

  describe("no take profits", () => {
    it("handles empty takeProfits array gracefully", async () => {
      const input = makeInput(store, { takeProfits: [] });
      await placeProtectionOrders(input, deps);

      expect(hlClient.placeStopOrder).toHaveBeenCalled();
      expect(hlClient.placeTpOrder).not.toHaveBeenCalled();

      expect(positionBook.isFlat("BTC")).toBe(false);

      const orders = store.getRecentOrders(10);
      expect(orders.find((o) => o.tag === "sl")).toBeDefined();
      expect(orders.filter((o) => o.tag.startsWith("tp"))).toHaveLength(0);
    });
  });
});
