import { describe, it, expect, vi } from "vitest";
import { reconcile, ReconcileLoop } from "./reconcile-loop.js";
import { PositionBook } from "../domain/position-book.js";
import type { HlPosition } from "../adapters/hyperliquid-client.js";

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
      { coin: "BTC", size: 0.01, entryPrice: 95000, unrealizedPnl: 5, leverage: 5 },
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
      { coin: "ETH", size: 1, entryPrice: 3500, unrealizedPnl: 10, leverage: 3 },
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
      { coin: "BTC", size: 0.02, entryPrice: 95000, unrealizedPnl: 0, leverage: 5 },
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
      { coin: "BTC", size: 1.005, entryPrice: 95000, unrealizedPnl: 0, leverage: 5 },
    ];

    const result = reconcile(local, hl);
    expect(result.ok).toBe(true);
  });
});

describe("ReconcileLoop", () => {
  it("check() calls HL and logs result", async () => {
    const positionBook = new PositionBook();
    const hlClient = {
      connect: vi.fn(),
      setLeverage: vi.fn(),
      placeMarketOrder: vi.fn(),
      placeStopOrder: vi.fn(),
      placeLimitOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getPositions: vi.fn().mockResolvedValue([]),
      getAccountEquity: vi.fn().mockResolvedValue(1000),
    };
    const eventLog = { append: vi.fn() };

    const loop = new ReconcileLoop({ hlClient, positionBook, eventLog, walletAddress: "0xtest" });
    const result = await loop.check();

    expect(result.ok).toBe(true);
    expect(hlClient.getPositions).toHaveBeenCalledOnce();
    expect(eventLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reconcile_ok" }),
    );
  });
});
