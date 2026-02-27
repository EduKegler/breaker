import { describe, it, expect, vi } from "vitest";
import type { HlClient, HlPosition } from "./hyperliquid-client.js";

function createMockClient(): HlClient {
  const positions: HlPosition[] = [];
  return {
    connect: vi.fn(),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
    placeStopOrder: vi.fn().mockResolvedValue({ orderId: "HL-2", status: "placed" }),
    placeLimitOrder: vi.fn().mockResolvedValue({ orderId: "HL-3", status: "placed" }),
    cancelOrder: vi.fn(),
    getPositions: vi.fn().mockResolvedValue(positions),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getHistoricalOrders: vi.fn().mockResolvedValue([]),
    getAccountEquity: vi.fn().mockResolvedValue(1000),
  };
}

describe("HlClient interface (mock)", () => {
  it("places market order", async () => {
    const client = createMockClient();
    const result = await client.placeMarketOrder("BTC", true, 0.01);
    expect(result.orderId).toBe("HL-1");
    expect(client.placeMarketOrder).toHaveBeenCalledWith("BTC", true, 0.01);
  });

  it("places stop order", async () => {
    const client = createMockClient();
    const result = await client.placeStopOrder("BTC", false, 0.01, 94000, true);
    expect(result.orderId).toBe("HL-2");
  });

  it("places limit order", async () => {
    const client = createMockClient();
    const result = await client.placeLimitOrder("BTC", false, 0.005, 97000, true);
    expect(result.orderId).toBe("HL-3");
  });

  it("sets leverage once per coin", async () => {
    const client = createMockClient();
    await client.setLeverage("BTC", 5, false);
    expect(client.setLeverage).toHaveBeenCalledWith("BTC", 5, false);
  });

  it("gets positions", async () => {
    const client = createMockClient();
    const positions = await client.getPositions("0xtest");
    expect(positions).toEqual([]);
  });

  it("gets account equity", async () => {
    const client = createMockClient();
    const equity = await client.getAccountEquity("0xtest");
    expect(equity).toBe(1000);
  });
});

export { createMockClient };
