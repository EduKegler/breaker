import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSignal, type SignalHandlerDeps, type HandleSignalInput } from "./signal-handler.js";
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
  dataSource: "hyperliquid",
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
      setLeverage: vi.fn(),
      placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
      placeStopOrder: vi.fn().mockResolvedValue({ orderId: "HL-2", status: "placed" }),
      placeLimitOrder: vi.fn().mockResolvedValue({ orderId: "HL-3", status: "placed" }),
      cancelOrder: vi.fn(),
      getPositions: vi.fn().mockResolvedValue([]),
      getAccountEquity: vi.fn().mockResolvedValue(1000),
    },
    store: new SqliteStore(":memory:"),
    eventLog: { append: vi.fn() },
    alertsClient: { notifyPositionOpened: vi.fn() },
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

    // Verify market order placed
    expect(deps.hlClient.placeMarketOrder).toHaveBeenCalledOnce();

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
