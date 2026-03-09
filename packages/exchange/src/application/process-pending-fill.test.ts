import { describe, it, expect, vi, beforeEach } from "vitest";
import { processPendingFill } from "./process-pending-fill.js";
import { PendingEntryBook } from "../domain/pending-entry-book.js";
import { PositionBook } from "../domain/position-book.js";
import { SqliteStore } from "../adapters/sqlite-store.js";
import type { HlClient } from "../types/hl-client.js";
import type { EventLog } from "../adapters/event-log.js";
import type { AlertsClient } from "../types/alerts-client.js";
import type { WsUserFill } from "../types/hl-event-stream.js";

function createMockHlClient(): HlClient {
  return {
    connect: vi.fn(),
    getSzDecimals: vi.fn().mockReturnValue(5),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
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

function makeFill(overrides: Partial<WsUserFill> = {}): WsUserFill {
  return {
    coin: "BTC",
    px: "60000",
    sz: "0.01",
    side: "B",
    time: Date.now(),
    startPosition: "0",
    dir: "Open Long",
    closedPnl: "0",
    hash: "0xabc",
    oid: 200,
    crossed: false,
    fee: "0.009",
    tid: 1,
    ...overrides,
  };
}

describe("processPendingFill", () => {
  let pendingEntryBook: PendingEntryBook;
  let positionBook: PositionBook;
  let hlClient: HlClient;
  let store: SqliteStore;
  let eventLog: EventLog;
  let alertsClient: AlertsClient;

  beforeEach(() => {
    pendingEntryBook = new PendingEntryBook();
    positionBook = new PositionBook();
    hlClient = createMockHlClient();
    store = new SqliteStore(":memory:");
    eventLog = { append: vi.fn() } as unknown as EventLog;
    alertsClient = { notifyPositionOpened: vi.fn(), notifyTrailingSlMoved: vi.fn(), sendText: vi.fn() } as unknown as AlertsClient;
  });

  it("returns false when fill does not match any pending entry", async () => {
    const fill = makeFill({ oid: 999 });
    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });
    expect(result).toBe(false);
  });

  it("processes fill for matching pending entry — opens position with SL/TP", async () => {
    // Add a pending entry
    const signalId = store.insertSignal({
      alert_id: "gtc-001", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: JSON.stringify([{ price: 62000, pctOfPosition: 1 }]),
      risk_check_passed: 1, risk_check_reason: null, strategy_name: "test-strat",
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 200, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000,
      takeProfits: [{ price: 62000, pctOfPosition: 1 }],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: "test-strat", comment: "breakout",
    });

    const fill = makeFill({ oid: 200, px: "60000", sz: "0.01" });

    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(result).toBe(true);

    // Pending entry removed
    expect(pendingEntryBook.has("BTC")).toBe(false);

    // Position opened
    expect(positionBook.isFlat("BTC")).toBe(false);
    const pos = positionBook.get("BTC")!;
    expect(pos.direction).toBe("long");
    expect(pos.size).toBe(0.01);
    expect(pos.stopLoss).toBe(59000);

    // SL placed
    expect(hlClient.placeStopOrder).toHaveBeenCalled();
    // TP placed
    expect(hlClient.placeTpOrder).toHaveBeenCalled();
  });

  it("returns false when fill.sz is not a valid number", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-nan-1", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 300, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 300, sz: "not-a-number", px: "60000" });

    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(result).toBe(false);
    // Should not have placed any protection orders
    expect(hlClient.placeStopOrder).not.toHaveBeenCalled();
  });

  it("returns false when fill.px is empty string", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-nan-2", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 301, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 301, sz: "0.01", px: "" });

    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(result).toBe(false);
    expect(hlClient.placeStopOrder).not.toHaveBeenCalled();
  });

  it("returns false when fill values are Infinity", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-nan-3", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 302, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 302, sz: "Infinity", px: "60000" });

    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(result).toBe(false);
    expect(hlClient.placeStopOrder).not.toHaveBeenCalled();
  });

  it("updates entry order status to filled in store", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-002", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    store.insertOrder({
      signal_id: signalId, hl_order_id: "200", coin: "BTC", side: "buy",
      size: 0.01, price: 60000, order_type: "limit", tag: "entry",
      status: "pending", mode: "testnet", filled_at: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 200, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 200, px: "60050", sz: "0.01" });

    await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    // Entry order should be marked filled
    const orders = store.getRecentOrders(10);
    const entryOrder = orders.find((o) => o.tag === "entry");
    expect(entryOrder?.status).toBe("filled");
  });

  it("uses fill price/size (not pending entry values) for protection orders", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-fill-vals", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: JSON.stringify([{ price: 62000, pctOfPosition: 1 }]),
      risk_check_passed: 1, risk_check_reason: null, strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 400, direction: "long", size: 0.02,
      price: 60000, stopLoss: 59000,
      takeProfits: [{ price: 62000, pctOfPosition: 1 }],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    // Fill at different price and size than the pending entry
    const fill = makeFill({ oid: 400, px: "59500", sz: "0.015" });

    await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    // Protection orders use fill values, not pending values
    expect(hlClient.placeStopOrder).toHaveBeenCalledWith("BTC", false, 0.015, 59000, true);
    const pos = positionBook.get("BTC")!;
    expect(pos.entryPrice).toBe(59500);
    expect(pos.size).toBe(0.015);
  });

  it("processes short direction fill correctly", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-short-1", source: "strategy-runner", asset: "BTC",
      side: "SHORT", entry_price: 60000, stop_loss: 61000,
      take_profits: JSON.stringify([{ price: 58000, pctOfPosition: 1 }]),
      risk_check_passed: 1, risk_check_reason: null, strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 500, direction: "short", size: 0.01,
      price: 60000, stopLoss: 61000,
      takeProfits: [{ price: 58000, pctOfPosition: 1 }],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 500, px: "60000", sz: "0.01", side: "A" });

    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(result).toBe(true);
    // Short -> entrySide=sell -> isBuy=true for SL/TP (opposite side to close)
    expect(hlClient.placeStopOrder).toHaveBeenCalledWith("BTC", true, 0.01, 61000, true);
    expect(hlClient.placeTpOrder).toHaveBeenCalledWith("BTC", true, 0.01, 58000, true);
    expect(positionBook.get("BTC")!.direction).toBe("short");
  });

  it("appends gtc_entry_filled event to event log", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-event-1", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 600, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 600, px: "60000", sz: "0.01" });

    await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "gtc_entry_filled",
        data: expect.objectContaining({
          signalId,
          coin: "BTC",
          hlOrderId: 600,
          filledSize: 0.01,
          filledPrice: 60000,
        }),
      }),
    );
  });

  it("updates signal outcome to executed", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-outcome-1", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null, outcome: "resting",
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 700, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 700, px: "60000", sz: "0.01" });

    await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    const signals = store.getRecentSignals(10);
    const signal = signals.find((s) => s.id === signalId);
    expect(signal?.outcome).toBe("executed");
  });

  it("sends notification via alertsClient on successful fill", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-notify-1", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: JSON.stringify([{ price: 62000, pctOfPosition: 1 }]),
      risk_check_passed: 1, risk_check_reason: null, strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 800, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000,
      takeProfits: [{ price: 62000, pctOfPosition: 1 }],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "breakout signal",
    });

    const fill = makeFill({ oid: 800, px: "60000", sz: "0.01" });

    await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(alertsClient.notifyPositionOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        coin: "BTC",
        side: "buy",
        size: 0.01,
        entryPrice: 60000,
        stopLoss: 59000,
        direction: "long",
        entryType: "gtc",
        comment: "breakout signal",
      }),
      "testnet",
    );
  });

  it("still completes when notification fails", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-notify-fail", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 900, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    vi.mocked(alertsClient.notifyPositionOpened).mockRejectedValueOnce(new Error("network error"));

    const fill = makeFill({ oid: 900, px: "60000", sz: "0.01" });

    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    // Should still succeed despite notification failure
    expect(result).toBe(true);
    expect(positionBook.isFlat("BTC")).toBe(false);
  });

  it("proceeds when no entry order exists in store (WS fill arrives before order INSERT)", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-race-1", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    // Add pending entry but do NOT insert the order row in store
    // (simulates WS fill arriving before the order INSERT completes)
    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 1000, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 1000, px: "60000", sz: "0.01" });

    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    // Should still complete — just skips order status update
    expect(result).toBe(true);
    expect(positionBook.isFlat("BTC")).toBe(false);
    // SL/TP should still be placed
    expect(hlClient.placeStopOrder).toHaveBeenCalled();
  });

  it("handles duplicate fill insertion gracefully (catch block)", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-dup-fill", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    const orderId = store.insertOrder({
      signal_id: signalId, hl_order_id: "1100", coin: "BTC", side: "buy",
      size: 0.01, price: 60000, order_type: "limit", tag: "entry",
      status: "pending", mode: "testnet", filled_at: null,
    });

    // Pre-insert a fill (simulates a duplicate scenario)
    store.insertFill({
      order_id: orderId,
      price: 60000,
      size: 0.01,
      fee: 0.009,
      timestamp: new Date().toISOString(),
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 1100, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    const fill = makeFill({ oid: 1100, px: "60000", sz: "0.01" });

    // Should not throw even if fill insertion fails (no UNIQUE constraint here,
    // but the catch block handles any insertFill error)
    const result = await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(result).toBe(true);
    expect(positionBook.isFlat("BTC")).toBe(false);
  });

  it("removes pending entry from book even when fill values are used for position", async () => {
    const signalId = store.insertSignal({
      alert_id: "gtc-remove-pending", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 60000, stop_loss: 59000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
      strategy_name: null,
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 1200, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000, takeProfits: [],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: null, comment: "",
    });

    expect(pendingEntryBook.has("BTC")).toBe(true);
    expect(pendingEntryBook.count()).toBe(1);

    const fill = makeFill({ oid: 1200, px: "60000", sz: "0.01" });

    await processPendingFill(fill, {
      pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: "testnet",
    });

    expect(pendingEntryBook.has("BTC")).toBe(false);
    expect(pendingEntryBook.count()).toBe(0);
  });
});
