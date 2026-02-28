import { describe, it, expect } from "vitest";
import { DryRunHlClient } from "./dry-run-client.js";

describe("DryRunHlClient", () => {
  it("getSzDecimals returns 5 (default fallback)", () => {
    const client = new DryRunHlClient();
    expect(client.getSzDecimals("BTC")).toBe(5);
    expect(client.getSzDecimals("ETH")).toBe(5);
  });

  it("connect is a no-op", async () => {
    const client = new DryRunHlClient();
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it("setLeverage is a no-op", async () => {
    const client = new DryRunHlClient();
    await expect(client.setLeverage("BTC", 5, false)).resolves.toBeUndefined();
  });

  it("placeMarketOrder returns simulated result with incrementing orderId", async () => {
    const client = new DryRunHlClient();
    const r1 = await client.placeMarketOrder("BTC", true, 0.01);
    expect(r1.orderId).toBe("dry-run-1");
    expect(r1.status).toBe("simulated");

    const r2 = await client.placeMarketOrder("ETH", false, 1.5);
    expect(r2.orderId).toBe("dry-run-2");
  });

  it("placeStopOrder returns simulated result", async () => {
    const client = new DryRunHlClient();
    const r = await client.placeStopOrder("BTC", false, 0.01, 94000, true);
    expect(r.orderId).toBe("dry-run-1");
    expect(r.status).toBe("simulated");
  });

  it("placeEntryOrder returns simulated full fill", async () => {
    const client = new DryRunHlClient();
    const r = await client.placeEntryOrder("BTC", true, 0.01, 95000, 10);
    expect(r.orderId).toBe("dry-run-1");
    expect(r.status).toBe("simulated");
    expect(r.filledSize).toBe(0.01);
    expect(r.avgPrice).toBe(95000);
  });

  it("placeLimitOrder returns simulated result", async () => {
    const client = new DryRunHlClient();
    const r = await client.placeLimitOrder("BTC", false, 0.005, 97000, true);
    expect(r.orderId).toBe("dry-run-1");
    expect(r.status).toBe("simulated");
  });

  it("cancelOrder is a no-op", async () => {
    const client = new DryRunHlClient();
    await expect(client.cancelOrder("BTC", 12345)).resolves.toBeUndefined();
  });

  it("getPositions returns empty array", async () => {
    const client = new DryRunHlClient();
    expect(await client.getPositions("0xtest")).toEqual([]);
  });

  it("getOpenOrders returns empty array", async () => {
    const client = new DryRunHlClient();
    expect(await client.getOpenOrders("0xtest")).toEqual([]);
  });

  it("getHistoricalOrders returns empty array", async () => {
    const client = new DryRunHlClient();
    expect(await client.getHistoricalOrders("0xtest")).toEqual([]);
  });

  it("getOrderStatus returns null", async () => {
    const client = new DryRunHlClient();
    expect(await client.getOrderStatus("0xtest", 12345)).toBeNull();
  });

  it("getAccountEquity returns 0", async () => {
    const client = new DryRunHlClient();
    expect(await client.getAccountEquity("0xtest")).toBe(0);
  });
});
