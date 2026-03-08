import { describe, it, expect, vi } from "vitest";
import { cancelPendingGtcOrders, type CancelPendingGtcDeps } from "./cancel-pending-gtc-orders.js";
import { PendingEntryBook, type PendingEntry } from "../domain/pending-entry-book.js";
import type { HlClient } from "../types/hl-client.js";

function createMockHlClient(overrides: Partial<HlClient> = {}): HlClient {
  return {
    connect: vi.fn(),
    getSzDecimals: vi.fn().mockReturnValue(5),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn(),
    placeEntryOrder: vi.fn(),
    placeGtcEntryOrder: vi.fn(),
    placeStopOrder: vi.fn(),
    placeLimitOrder: vi.fn(),
    placeTpOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getHistoricalOrders: vi.fn().mockResolvedValue([]),
    getOrderStatus: vi.fn().mockResolvedValue(null),
    getAccountEquity: vi.fn().mockResolvedValue(1000),
    getAccountState: vi.fn().mockResolvedValue({ accountValue: 0, totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 0, spotBalances: [] }),
    getMidPrice: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makePendingEntry(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    coin: "BTC",
    hlOrderId: 12345,
    direction: "long",
    size: 0.01,
    price: 95000,
    stopLoss: 94000,
    takeProfits: [],
    expiresAt: Date.now() + 60_000,
    signalId: 1,
    leverage: 5,
    strategyName: "donchian-adx",
    comment: "test",
    ...overrides,
  };
}

function createDeps(overrides: Partial<CancelPendingGtcDeps> = {}): CancelPendingGtcDeps {
  return {
    pendingEntryBook: new PendingEntryBook(),
    hlClient: createMockHlClient(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

describe("cancelPendingGtcOrders", () => {
  it("returns 0 when no pending entries exist", async () => {
    const deps = createDeps();
    const result = await cancelPendingGtcOrders(deps);
    expect(result).toBe(0);
    expect(deps.hlClient.cancelOrder).not.toHaveBeenCalled();
  });

  it("cancels a single pending GTC order", async () => {
    const deps = createDeps();
    deps.pendingEntryBook.add(makePendingEntry({ coin: "BTC", hlOrderId: 111 }));

    const result = await cancelPendingGtcOrders(deps);

    expect(result).toBe(1);
    expect(deps.hlClient.cancelOrder).toHaveBeenCalledWith("BTC", 111);
    expect(deps.pendingEntryBook.count()).toBe(0);
  });

  it("cancels multiple pending GTC orders", async () => {
    const deps = createDeps();
    deps.pendingEntryBook.add(makePendingEntry({ coin: "BTC", hlOrderId: 111 }));
    deps.pendingEntryBook.add(makePendingEntry({ coin: "ETH", hlOrderId: 222 }));
    deps.pendingEntryBook.add(makePendingEntry({ coin: "SOL", hlOrderId: 333 }));

    const result = await cancelPendingGtcOrders(deps);

    expect(result).toBe(3);
    expect(deps.hlClient.cancelOrder).toHaveBeenCalledTimes(3);
    expect(deps.pendingEntryBook.count()).toBe(0);
  });

  it("continues cancelling when one order fails", async () => {
    const hlClient = createMockHlClient({
      cancelOrder: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(undefined),
    });
    const deps = createDeps({ hlClient });
    deps.pendingEntryBook.add(makePendingEntry({ coin: "BTC", hlOrderId: 111 }));
    deps.pendingEntryBook.add(makePendingEntry({ coin: "ETH", hlOrderId: 222 }));
    deps.pendingEntryBook.add(makePendingEntry({ coin: "SOL", hlOrderId: 333 }));

    const result = await cancelPendingGtcOrders(deps);

    expect(result).toBe(2);
    expect(hlClient.cancelOrder).toHaveBeenCalledTimes(3);
    // Failed entry (ETH) remains in the book
    expect(deps.pendingEntryBook.has("ETH")).toBe(true);
    // Successful entries removed
    expect(deps.pendingEntryBook.has("BTC")).toBe(false);
    expect(deps.pendingEntryBook.has("SOL")).toBe(false);
  });

  it("logs warning on cancel failure without throwing", async () => {
    const hlClient = createMockHlClient({
      cancelOrder: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    const deps = createDeps({ hlClient });
    deps.pendingEntryBook.add(makePendingEntry({ coin: "BTC", hlOrderId: 111 }));

    const result = await cancelPendingGtcOrders(deps);

    expect(result).toBe(0);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ coin: "BTC", oid: 111 }),
      expect.stringContaining("Failed to cancel"),
    );
  });
});
