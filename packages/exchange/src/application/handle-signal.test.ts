import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSignal, type SignalHandlerDeps, type HandleSignalInput } from "./handle-signal.js";
import { PositionBook } from "../domain/position-book.js";
import { SqliteStore } from "../adapters/sqlite-store.js";
import type { ExchangeConfig } from "../types/config.js";
import type { Signal } from "@breaker/backtest";

const config: ExchangeConfig = {
  mode: "testnet",
  port: 3200,
  gatewayUrl: "http://localhost:3100",
  asset: "BTC",
  strategy: "donchian-adx",
  interval: "15m",
  dataSource: "binance",
  warmupBars: 200,
  leverage: 5,
  marginType: "isolated",
  guardrails: {
    maxNotionalUsd: 5000,
    maxLeverage: 5,
    maxOpenPositions: 1,
    maxDailyLossUsd: 100,
    maxTradesPerDay: 5,
    cooldownBars: 4,
  },
  sizing: {
    mode: "risk",
    riskPerTradeUsd: 10,
    cashPerTrade: 100,
  },
  autoTradingEnabled: true,
  entrySlippageBps: 10,
};

const signal: Signal = {
  direction: "long",
  entryPrice: 95000,
  stopLoss: 94000,
  takeProfits: [{ price: 97000, pctOfPosition: 0.5 }],
  comment: "Donchian breakout",
};

function createDeps(): SignalHandlerDeps {
  return {
    config,
    hlClient: {
      connect: vi.fn(),
      getSzDecimals: vi.fn().mockReturnValue(5),
      setLeverage: vi.fn(),
      placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
      placeEntryOrder: vi.fn().mockResolvedValue({ orderId: "HL-E1", filledSize: 0.01052, avgPrice: 95000, status: "placed" }),
      placeStopOrder: vi.fn().mockResolvedValue({ orderId: "HL-2", status: "placed" }),
      placeLimitOrder: vi.fn().mockResolvedValue({ orderId: "HL-3", status: "placed" }),
      cancelOrder: vi.fn(),
      getPositions: vi.fn().mockResolvedValue([]),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([]),
      getAccountEquity: vi.fn().mockResolvedValue(1000),
    },
    store: new SqliteStore(":memory:"),
    eventLog: { append: vi.fn() },
    alertsClient: { notifyPositionOpened: vi.fn(), notifyTrailingSlMoved: vi.fn(), sendText: vi.fn() },
    positionBook: new PositionBook(),
  };
}

let deps: SignalHandlerDeps;

beforeEach(() => {
  deps = createDeps();
});

describe("handleSignal", () => {
  it("processes signal end-to-end successfully", async () => {
    const input: HandleSignalInput = {
      signal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "test-001",
    };

    const result = await handleSignal(input, deps);

    expect(result.success).toBe(true);
    expect(result.signalId).toBe(1);
    expect(result.intent).toBeDefined();
    expect(result.intent!.coin).toBe("BTC");

    // Verify leverage was set
    expect(deps.hlClient.setLeverage).toHaveBeenCalledWith("BTC", 5, false);

    // Verify entry order placed (limit IOC)
    expect(deps.hlClient.placeEntryOrder).toHaveBeenCalledOnce();

    // Verify SL placed
    expect(deps.hlClient.placeStopOrder).toHaveBeenCalledOnce();

    // Verify TP placed
    expect(deps.hlClient.placeLimitOrder).toHaveBeenCalledOnce();

    // Verify position opened
    expect(deps.positionBook.count()).toBe(1);
    expect(deps.positionBook.get("BTC")!.direction).toBe("long");

    // Verify notification sent
    expect(deps.alertsClient.notifyPositionOpened).toHaveBeenCalledOnce();

    // Verify events logged
    expect(deps.eventLog.append).toHaveBeenCalled();
  });

  it("rejects duplicate alert_id (idempotency)", async () => {
    const input: HandleSignalInput = {
      signal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "dup-001",
    };

    await handleSignal(input, deps);
    const result = await handleSignal(input, deps);

    expect(result.success).toBe(false);
    expect(result.reason).toContain("Duplicate");
  });

  it("rejects when risk check fails (max positions)", async () => {
    // Open a position first
    deps.positionBook.open({
      coin: "ETH",
      direction: "long",
      entryPrice: 3500,
      size: 1,
      stopLoss: 3400,
      takeProfits: [],
      openedAt: new Date().toISOString(),
      signalId: 0,
    });

    const input: HandleSignalInput = {
      signal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "risk-001",
    };

    const result = await handleSignal(input, deps);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Open positions");
  });

  it("rejects when notional exceeds max", async () => {
    const bigSignal: Signal = {
      direction: "long",
      entryPrice: 95000,
      stopLoss: 94999, // tiny stop distance → huge size
      takeProfits: [],
      comment: "Big entry",
    };

    const input: HandleSignalInput = {
      signal: bigSignal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "notional-001",
    };

    const result = await handleSignal(input, deps);
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Notional");
  });

  it("handles zero size signal gracefully", async () => {
    const zeroSignal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 100, // zero stop distance
      takeProfits: [],
      comment: "Zero",
    };

    const result = await handleSignal(
      { signal: zeroSignal, currentPrice: 100, source: "api", alertId: "zero-001" },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Size is zero");
  });

  it("calls onSignalProcessed after handling signal", async () => {
    const onSignalProcessed = vi.fn();
    deps.onSignalProcessed = onSignalProcessed;

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "callback-001" },
      deps,
    );

    expect(result.success).toBe(true);
    expect(onSignalProcessed).toHaveBeenCalledOnce();
  });

  it("returns failure when placeEntryOrder throws (entry)", async () => {
    (deps.hlClient.placeEntryOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Insufficient margin"),
    );

    const input: HandleSignalInput = {
      signal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "entry-fail-001",
    };

    await expect(handleSignal(input, deps)).rejects.toThrow("Insufficient margin");

    // Position should NOT be opened since entry failed
    expect(deps.positionBook.count()).toBe(0);
    // SL and TP should not be placed
    expect(deps.hlClient.placeStopOrder).not.toHaveBeenCalled();
    expect(deps.hlClient.placeLimitOrder).not.toHaveBeenCalled();
  });

  it("rolls back entry when SL placement fails (closes position)", async () => {
    (deps.hlClient.placeStopOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Stop order rejected"),
    );

    const input: HandleSignalInput = {
      signal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "sl-fail-001",
    };

    await expect(handleSignal(input, deps)).rejects.toThrow("Stop order rejected");

    // Entry order WAS placed via placeEntryOrder
    expect(deps.hlClient.placeEntryOrder).toHaveBeenCalledOnce();
    // Rollback uses placeMarketOrder (opposite side)
    expect(deps.hlClient.placeMarketOrder).toHaveBeenCalledOnce();
    const calls = (deps.hlClient.placeMarketOrder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(["BTC", false, expect.any(Number)]);  // rollback sell
    // Position should NOT be in book (rollback succeeded)
    expect(deps.positionBook.count()).toBe(0);
  });

  it("hydrates position with stopLoss=0 when both SL and rollback fail", async () => {
    (deps.hlClient.placeStopOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Stop order rejected"),
    );
    // Rollback placeMarketOrder fails
    (deps.hlClient.placeMarketOrder as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Cannot close"));

    const input: HandleSignalInput = {
      signal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "sl-rollback-fail-001",
    };

    await expect(handleSignal(input, deps)).rejects.toThrow("Stop order rejected");

    // Position should be hydrated with stopLoss=0 for visibility
    expect(deps.positionBook.count()).toBe(1);
    const pos = deps.positionBook.get("BTC")!;
    expect(pos.stopLoss).toBe(0);
    expect(pos.direction).toBe("long");
    expect(pos.signalId).toBe(1);
  });

  it("keeps position open when TP fails but SL succeeded (position is protected)", async () => {
    (deps.hlClient.placeLimitOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("TP order rejected"),
    );

    const input: HandleSignalInput = {
      signal,
      currentPrice: 95000,
      source: "strategy-runner",
      alertId: "tp-fail-001",
    };

    // TP failure should NOT crash — position is protected by SL
    const result = await handleSignal(input, deps);

    expect(result.success).toBe(true);
    // SL was placed, TP failed but was caught
    expect(deps.hlClient.placeStopOrder).toHaveBeenCalledOnce();
    // Position should be in book (SL protects it)
    expect(deps.positionBook.count()).toBe(1);
  });

  it("truncates size/price values before storing in positionBook and DB", async () => {
    // szDecimals=2 → size truncated to 2 decimals
    (deps.hlClient.getSzDecimals as ReturnType<typeof vi.fn>).mockReturnValue(2);
    // placeEntryOrder returns fill with the truncated size
    (deps.hlClient.placeEntryOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      orderId: "HL-E1", filledSize: 1.42, avgPrice: 100, status: "placed",
    });

    // Use lower price to keep notional within maxNotionalUsd guardrail (5000)
    // riskPerTradeUsd=10, stopDist=7 → raw size = 10/7 ≈ 1.42857...
    const tightSignal: Signal = {
      direction: "long",
      entryPrice: 100,
      stopLoss: 93, // stopDist=7 → raw size = 10/7 ≈ 1.42857...
      takeProfits: [{ price: 110, pctOfPosition: 0.5 }],
      comment: "Tight stop",
    };

    const result = await handleSignal(
      { signal: tightSignal, currentPrice: 100, source: "strategy-runner", alertId: "trunc-001" },
      deps,
    );

    expect(result.success).toBe(true);

    // Position book should have truncated size (1.42, not 1.42857...)
    const pos = deps.positionBook.get("BTC")!;
    expect(pos.size).toBe(1.42);

    // Entry order sent via placeEntryOrder
    expect(deps.hlClient.placeEntryOrder).toHaveBeenCalledWith("BTC", true, 1.42, 100, 10);

    // TP size also truncated: 1.42 * 0.5 = 0.71 (already clean, but verify)
    const tpCalls = (deps.hlClient.placeLimitOrder as ReturnType<typeof vi.fn>).mock.calls;
    expect(tpCalls[0][2]).toBe(0.71); // truncateSize(1.42 * 0.5, 2) = 0.71
  });

  it("rejects signal when size truncates to zero (edge case)", async () => {
    // szDecimals=0 → only whole units
    (deps.hlClient.getSzDecimals as ReturnType<typeof vi.fn>).mockReturnValue(0);

    // riskPerTradeUsd=10, stopDist=1000 → raw size = 0.01, truncated to 0
    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "trunc-zero-001" },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Size is zero");
    // No orders should be placed
    expect(deps.hlClient.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("aborts when entry gets no fill (IOC expired)", async () => {
    (deps.hlClient.placeEntryOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      orderId: "HL-E1", filledSize: 0, avgPrice: 0, status: "placed",
    });

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "no-fill-001" },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Entry order not filled");
    // No SL/TP should be placed
    expect(deps.hlClient.placeStopOrder).not.toHaveBeenCalled();
    expect(deps.hlClient.placeLimitOrder).not.toHaveBeenCalled();
    // Position should NOT be opened
    expect(deps.positionBook.count()).toBe(0);
    // entry_no_fill event logged
    const events = (deps.eventLog.append as ReturnType<typeof vi.fn>).mock.calls;
    const noFillEvent = events.find((c: unknown[]) => (c[0] as { type: string }).type === "entry_no_fill");
    expect(noFillEvent).toBeDefined();
  });

  it("aborts when filled size truncates to zero", async () => {
    // szDecimals=3 allows intent.size through, but exchange fills only 0.0005
    // which truncates to 0 with szDecimals=3
    (deps.hlClient.getSzDecimals as ReturnType<typeof vi.fn>).mockReturnValue(3);
    (deps.hlClient.placeEntryOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      orderId: "HL-E1", filledSize: 0.0005, avgPrice: 95000, status: "placed",
    });

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "trunc-fill-001" },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Entry order not filled");
    expect(deps.positionBook.count()).toBe(0);
  });

  it("adjusts SL/TP sizes on partial fill", async () => {
    // Request 0.01052, get 0.005 filled
    (deps.hlClient.placeEntryOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      orderId: "HL-E1", filledSize: 0.005, avgPrice: 95100, status: "placed",
    });

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "partial-001" },
      deps,
    );

    expect(result.success).toBe(true);

    // SL should use actualSize (0.005), not intent.size
    const slCalls = (deps.hlClient.placeStopOrder as ReturnType<typeof vi.fn>).mock.calls;
    expect(slCalls[0][2]).toBe(0.005);

    // TP size should be based on actualSize: truncateSize(0.005 * 0.5, 5) = 0.0025
    const tpCalls = (deps.hlClient.placeLimitOrder as ReturnType<typeof vi.fn>).mock.calls;
    expect(tpCalls[0][2]).toBe(0.0025);

    // Position book should reflect actual filled size and avgPrice
    const pos = deps.positionBook.get("BTC")!;
    expect(pos.size).toBe(0.005);
    expect(pos.entryPrice).toBe(95100);
  });

  it("propagates avgPrice to positionBook on full fill", async () => {
    (deps.hlClient.placeEntryOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      orderId: "HL-E1", filledSize: 0.01052, avgPrice: 94980, status: "placed",
    });

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "avgpx-001" },
      deps,
    );

    expect(result.success).toBe(true);
    const pos = deps.positionBook.get("BTC")!;
    // avgPrice from exchange, not signal entryPrice
    expect(pos.entryPrice).toBe(94980);
  });

  it("blocks strategy-runner signal when autoTradingEnabled is false", async () => {
    deps.config = { ...config, autoTradingEnabled: false };

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "auto-off-001" },
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Auto-trading disabled");
    expect(result.signalId).toBe(-1);
    // No orders should be placed
    expect(deps.hlClient.placeEntryOrder).not.toHaveBeenCalled();
    expect(deps.positionBook.count()).toBe(0);
  });

  it("allows api signal when autoTradingEnabled is false", async () => {
    deps.config = { ...config, autoTradingEnabled: false };

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "api", alertId: "auto-off-api-001" },
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.hlClient.placeEntryOrder).toHaveBeenCalledOnce();
  });

  it("allows router signal when autoTradingEnabled is false", async () => {
    deps.config = { ...config, autoTradingEnabled: false };

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "router", alertId: "auto-off-router-001" },
      deps,
    );

    expect(result.success).toBe(true);
    expect(deps.hlClient.placeEntryOrder).toHaveBeenCalledOnce();
  });

  it("continues even when notification fails", async () => {
    (deps.alertsClient.notifyPositionOpened as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("WhatsApp down"));

    const result = await handleSignal(
      { signal, currentPrice: 95000, source: "strategy-runner", alertId: "notify-fail" },
      deps,
    );

    expect(result.success).toBe(true);
    // notification_failed event should be logged
    const calls = (deps.eventLog.append as ReturnType<typeof vi.fn>).mock.calls;
    const failEvent = calls.find((c: unknown[]) => (c[0] as { type: string }).type === "notification_failed");
    expect(failEvent).toBeDefined();
  });
});
