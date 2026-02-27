import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reconcile, ReconcileLoop } from "./reconcile-loop.js";
import { PositionBook } from "../domain/position-book.js";
import { SqliteStore } from "../adapters/sqlite-store.js";
import type { HlClient, HlPosition, HlOpenOrder, HlHistoricalOrder } from "../adapters/hyperliquid-client.js";

function createMockHlClient(overrides: Partial<HlClient> = {}): HlClient {
  return {
    connect: vi.fn(),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn(),
    placeStopOrder: vi.fn(),
    placeLimitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getHistoricalOrders: vi.fn().mockResolvedValue([]),
    getAccountEquity: vi.fn().mockResolvedValue(1000),
    ...overrides,
  };
}

describe("reconcile", () => {
  it("reports ok when positions match", () => {
    const local = [
      {
        coin: "BTC",
        direction: "long" as const,
        entryPrice: 95000,
        size: 0.01,
        stopLoss: 94000,
        takeProfits: [],
        currentPrice: 95500,
        unrealizedPnl: 5,
        openedAt: "2024-01-01T00:00:00Z",
        signalId: 1,
      },
    ];
    const hl: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.01, entryPrice: 95000, unrealizedPnl: 5, leverage: 5 },
    ];

    const result = reconcile(local, hl);
    expect(result.ok).toBe(true);
    expect(result.drifts).toHaveLength(0);
  });

  it("detects local position missing from HL", () => {
    const local = [
      {
        coin: "BTC",
        direction: "long" as const,
        entryPrice: 95000,
        size: 0.01,
        stopLoss: 94000,
        takeProfits: [],
        currentPrice: 95000,
        unrealizedPnl: 0,
        openedAt: "2024-01-01T00:00:00Z",
        signalId: 1,
      },
    ];
    const hl: HlPosition[] = [];

    const result = reconcile(local, hl);
    expect(result.ok).toBe(false);
    expect(result.drifts[0]).toContain("not on Hyperliquid");
  });

  it("detects HL position not tracked locally", () => {
    const hl: HlPosition[] = [
      { coin: "ETH", direction: "long", size: 1, entryPrice: 3500, unrealizedPnl: 10, leverage: 3 },
    ];

    const result = reconcile([], hl);
    expect(result.ok).toBe(false);
    expect(result.drifts[0]).toContain("not tracked locally");
  });

  it("detects size drift", () => {
    const local = [
      {
        coin: "BTC",
        direction: "long" as const,
        entryPrice: 95000,
        size: 0.01,
        stopLoss: 94000,
        takeProfits: [],
        currentPrice: 95000,
        unrealizedPnl: 0,
        openedAt: "2024-01-01T00:00:00Z",
        signalId: 1,
      },
    ];
    const hl: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.02, entryPrice: 95000, unrealizedPnl: 0, leverage: 5 },
    ];

    const result = reconcile(local, hl);
    expect(result.ok).toBe(false);
    expect(result.drifts[0]).toContain("size drift");
  });

  it("ignores small size differences (<1%)", () => {
    const local = [
      {
        coin: "BTC",
        direction: "long" as const,
        entryPrice: 95000,
        size: 1.0,
        stopLoss: 94000,
        takeProfits: [],
        currentPrice: 95000,
        unrealizedPnl: 0,
        openedAt: "2024-01-01T00:00:00Z",
        signalId: 1,
      },
    ];
    const hl: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 1.005, entryPrice: 95000, unrealizedPnl: 0, leverage: 5 },
    ];

    const result = reconcile(local, hl);
    expect(result.ok).toBe(true);
  });
});

describe("ReconcileLoop", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("check() calls HL and logs result when no drifts", async () => {
    const positionBook = new PositionBook();
    const hlClient = createMockHlClient();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    const result = await loop.check();

    expect(result.ok).toBe(true);
    expect(result.actions).toHaveLength(0);
    expect(hlClient.getPositions).toHaveBeenCalledOnce();
    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reconcile_ok" }),
    );
  });

  it("hydrates position when HL has it but local does not", async () => {
    const positionBook = new PositionBook();
    const hlPositions: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.01, entryPrice: 95000, unrealizedPnl: 5, leverage: 5 },
    ];
    const hlClient = createMockHlClient({
      getPositions: vi.fn().mockResolvedValue(hlPositions),
    });
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    const result = await loop.check();

    expect(result.actions).toContain("position_hydrated:BTC");
    expect(positionBook.get("BTC")).not.toBeNull();
    expect(positionBook.get("BTC")!.direction).toBe("long");
    expect(positionBook.get("BTC")!.size).toBe(0.01);
    expect(positionBook.get("BTC")!.entryPrice).toBe(95000);
    expect(positionBook.get("BTC")!.signalId).toBe(-1);
    expect(positionBook.get("BTC")!.stopLoss).toBe(0);
  });

  it("auto-closes position when local has it but HL does not", async () => {
    const positionBook = new PositionBook();
    positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      openedAt: "2024-01-01T00:00:00Z",
      signalId: 1,
    });

    const hlClient = createMockHlClient({
      getPositions: vi.fn().mockResolvedValue([]),
    });
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    const result = await loop.check();

    expect(result.actions).toContain("position_auto_closed:BTC");
    expect(positionBook.isFlat("BTC")).toBe(true);
  });

  it("syncs filled order when HL historical shows triggered", async () => {
    // Insert a signal and a pending SL order
    store.insertSignal({
      alert_id: "sig-001", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "123", coin: "BTC", side: "sell",
      size: 0.01, price: 94000, order_type: "stop", tag: "sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlClient = createMockHlClient({
      getOpenOrders: vi.fn().mockResolvedValue([]), // SL no longer open
      getHistoricalOrders: vi.fn().mockResolvedValue([
        { oid: 123, status: "triggered" },
      ] as HlHistoricalOrder[]),
    });
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("filled");
    expect(orders[0].filled_at).toBeTruthy();
  });

  it("syncs cancelled order when HL historical shows canceled", async () => {
    store.insertSignal({
      alert_id: "sig-002", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "456", coin: "BTC", side: "sell",
      size: 0.005, price: 97000, order_type: "limit", tag: "tp1",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlClient = createMockHlClient({
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([
        { oid: 456, status: "canceled" },
      ] as HlHistoricalOrder[]),
    });
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("cancelled");
  });

  it("keeps order as pending when still in HL open orders", async () => {
    store.insertSignal({
      alert_id: "sig-003", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "789", coin: "BTC", side: "sell",
      size: 0.01, price: 94000, order_type: "stop", tag: "sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const openOrders: HlOpenOrder[] = [
      { coin: "BTC", oid: 789, side: "sell", sz: 0.01, limitPx: 94000, orderType: "Stop Market", isTrigger: true, triggerPx: 94000, triggerCondition: "lt", reduceOnly: true, isPositionTpsl: true },
    ];
    const hlClient = createMockHlClient({
      getOpenOrders: vi.fn().mockResolvedValue(openOrders),
    });
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    const result = await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("pending"); // unchanged
    expect(result.actions.filter((a) => a.startsWith("order_status_synced"))).toHaveLength(0);
  });

  it("ignores orders without hl_order_id", async () => {
    store.insertSignal({
      alert_id: "sig-004", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: null, coin: "BTC", side: "buy",
      size: 0.01, price: 95000, order_type: "market", tag: "entry",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlClient = createMockHlClient();
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    const result = await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("pending"); // unchanged, ignored
    expect(result.actions.filter((a) => a.startsWith("order_status_synced"))).toHaveLength(0);
  });

  it("syncs rejected order from HL historical", async () => {
    store.insertSignal({
      alert_id: "sig-005", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "999", coin: "BTC", side: "sell",
      size: 0.01, price: 94000, order_type: "stop", tag: "sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlClient = createMockHlClient({
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([
        { oid: 999, status: "rejected" },
      ] as HlHistoricalOrder[]),
    });
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("rejected");
  });

  it("hydrates position with correct currentPrice and unrealizedPnl from HL", async () => {
    const positionBook = new PositionBook();
    const hlPositions: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.01, entryPrice: 95000, unrealizedPnl: 50, leverage: 5 },
    ];
    const hlClient = createMockHlClient({
      getPositions: vi.fn().mockResolvedValue(hlPositions),
    });
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const pos = positionBook.get("BTC")!;
    // currentPrice = entryPrice + unrealizedPnl / size = 95000 + 50/0.01 = 100000
    expect(pos.currentPrice).toBe(100000);
    expect(pos.unrealizedPnl).toBe(50);
  });

  it("ignores orders with hl_order_id = 'unknown' (NaN guard)", async () => {
    store.insertSignal({
      alert_id: "sig-nan", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "unknown", coin: "BTC", side: "sell",
      size: 0.01, price: 94000, order_type: "stop", tag: "sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlClient = createMockHlClient({
      getOpenOrders: vi.fn().mockResolvedValue([]),
    });
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    const result = await loop.check();

    // Should not call getHistoricalOrders since the only trackable order has NaN oid
    expect(hlClient.getHistoricalOrders).not.toHaveBeenCalled();
    // Order stays pending (not crashed)
    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("pending");
  });

  it("updates currentPrice for existing positions on every check tick", async () => {
    const positionBook = new PositionBook();
    positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      openedAt: "2024-01-01T00:00:00Z",
      signalId: 1,
    });

    // HL reports updated PnL
    const hlPositions: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.01, entryPrice: 95000, unrealizedPnl: 30, leverage: 5 },
    ];
    const hlClient = createMockHlClient({
      getPositions: vi.fn().mockResolvedValue(hlPositions),
    });
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const pos = positionBook.get("BTC")!;
    // currentPrice = 95000 + 30/0.01 = 98000
    expect(pos.currentPrice).toBe(98000);
    expect(pos.unrealizedPnl).toBe(30);
  });

  it("inserts equity snapshot after check()", async () => {
    const positionBook = new PositionBook();
    positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      openedAt: "2024-01-01T00:00:00Z",
      signalId: 1,
    });

    const hlPositions: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.01, entryPrice: 95000, unrealizedPnl: 20, leverage: 5 },
    ];
    const hlClient = createMockHlClient({
      getPositions: vi.fn().mockResolvedValue(hlPositions),
      getAccountEquity: vi.fn().mockResolvedValue(1020),
    });
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const snapshots = store.getEquitySnapshots(10);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].equity).toBe(1020);
    expect(snapshots[0].open_positions).toBe(1);
    expect(hlClient.getAccountEquity).toHaveBeenCalledWith("0xtest");
  });

  it("calls onReconciled after check with current state", async () => {
    const positionBook = new PositionBook();
    positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      openedAt: "2024-01-01T00:00:00Z",
      signalId: 1,
    });

    const hlPositions: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.01, entryPrice: 95000, unrealizedPnl: 20, leverage: 5 },
    ];
    const openOrders: HlOpenOrder[] = [
      { coin: "BTC", oid: 100, side: "A", sz: 0.01, limitPx: 94000, orderType: "Stop Market", isTrigger: true, triggerPx: 94000, triggerCondition: "lt", reduceOnly: true, isPositionTpsl: true },
    ];
    const hlClient = createMockHlClient({
      getPositions: vi.fn().mockResolvedValue(hlPositions),
      getOpenOrders: vi.fn().mockResolvedValue(openOrders),
      getAccountEquity: vi.fn().mockResolvedValue(1020),
    });
    const eventLog = { append: vi.fn() };
    const onReconciled = vi.fn();

    const loop = new ReconcileLoop({
      hlClient, positionBook, eventLog, store, walletAddress: "0xtest", onReconciled,
    });
    await loop.check();

    expect(onReconciled).toHaveBeenCalledOnce();
    const arg = onReconciled.mock.calls[0][0];
    expect(arg.positions).toHaveLength(1);
    expect(arg.openOrders).toHaveLength(1);
    expect(arg.equity).toBe(1020);
  });

  it("marks order as cancelled when not found in HL and no position exists", async () => {
    store.insertSignal({
      alert_id: "sig-orphan", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "77777", coin: "BTC", side: "sell",
      size: 0.01, price: 94000, order_type: "stop", tag: "sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlClient = createMockHlClient({
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([]), // not found
    });
    const positionBook = new PositionBook(); // no position for BTC
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("cancelled");
  });

  it("keeps order pending when not found in HL but position still exists", async () => {
    store.insertSignal({
      alert_id: "sig-active", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "88888", coin: "BTC", side: "sell",
      size: 0.01, price: 94000, order_type: "stop", tag: "sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlPositions: HlPosition[] = [
      { coin: "BTC", direction: "long", size: 0.01, entryPrice: 95000, unrealizedPnl: 5, leverage: 5 },
    ];
    const hlClient = createMockHlClient({
      getPositions: vi.fn().mockResolvedValue(hlPositions),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([]), // not found
    });
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("pending"); // position still open, keep pending
  });

  it("syncs marginCanceled order as cancelled", async () => {
    store.insertSignal({
      alert_id: "sig-006", source: "strategy-runner", asset: "BTC",
      side: "LONG", entry_price: 95000, stop_loss: 94000,
      take_profits: "[]", risk_check_passed: 1, risk_check_reason: null,
    });
    store.insertOrder({
      signal_id: 1, hl_order_id: "888", coin: "BTC", side: "sell",
      size: 0.01, price: 94000, order_type: "stop", tag: "sl",
      status: "pending", mode: "testnet", filled_at: null,
    });

    const hlClient = createMockHlClient({
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([
        { oid: 888, status: "marginCanceled" },
      ] as HlHistoricalOrder[]),
    });
    const positionBook = new PositionBook();
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, store, walletAddress: "0xtest" });
    await loop.check();

    const orders = store.getRecentOrders(10);
    expect(orders[0].status).toBe("cancelled");
  });
});
