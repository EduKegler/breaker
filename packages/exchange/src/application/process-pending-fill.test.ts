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
      risk_check_passed: 1, risk_check_reason: null, strategy_name: "donchian-adx",
    });

    pendingEntryBook.add({
      coin: "BTC", hlOrderId: 200, direction: "long", size: 0.01,
      price: 60000, stopLoss: 59000,
      takeProfits: [{ price: 62000, pctOfPosition: 1 }],
      expiresAt: Date.now() + 30 * 60 * 1000, signalId, leverage: 5,
      strategyName: "donchian-adx", comment: "breakout",
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
});
