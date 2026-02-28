import { describe, it, expect, vi } from "vitest";
import { resolveHistoricalStatuses } from "./resolve-historical-statuses.js";
import type { HlClient, HlHistoricalOrder } from "../types/hl-client.js";

function createMockHlClient(overrides: Partial<HlClient> = {}): HlClient {
  return {
    connect: vi.fn(),
    getSzDecimals: vi.fn().mockReturnValue(5),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn(),
    placeEntryOrder: vi.fn(),
    placeStopOrder: vi.fn(),
    placeLimitOrder: vi.fn(),
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

describe("resolveHistoricalStatuses", () => {
  it("returns statuses from getHistoricalOrders when all oids found", async () => {
    const hlClient = createMockHlClient({
      getHistoricalOrders: vi.fn().mockResolvedValue([
        { oid: 100, status: "filled" },
        { oid: 200, status: "canceled" },
      ] as HlHistoricalOrder[]),
    });

    const result = await resolveHistoricalStatuses(hlClient, "0xtest", [100, 200]);

    expect(result.get(100)).toBe("filled");
    expect(result.get(200)).toBe("canceled");
    expect(hlClient.getOrderStatus).not.toHaveBeenCalled();
  });

  it("falls back to getOrderStatus for missing oids", async () => {
    const hlClient = createMockHlClient({
      getHistoricalOrders: vi.fn().mockResolvedValue([
        { oid: 100, status: "filled" },
      ] as HlHistoricalOrder[]),
      getOrderStatus: vi.fn().mockResolvedValue({ oid: 200, status: "triggered" }),
    });

    const result = await resolveHistoricalStatuses(hlClient, "0xtest", [100, 200]);

    expect(result.get(100)).toBe("filled");
    expect(result.get(200)).toBe("triggered");
    expect(hlClient.getOrderStatus).toHaveBeenCalledWith("0xtest", 200);
  });

  it("fetches multiple missing oids in parallel", async () => {
    const hlClient = createMockHlClient({
      getHistoricalOrders: vi.fn().mockResolvedValue([]),
      getOrderStatus: vi.fn()
        .mockResolvedValueOnce({ oid: 1, status: "triggered" })
        .mockResolvedValueOnce({ oid: 2, status: "canceled" }),
    });

    const result = await resolveHistoricalStatuses(hlClient, "0xtest", [1, 2]);

    expect(result.get(1)).toBe("triggered");
    expect(result.get(2)).toBe("canceled");
    expect(hlClient.getOrderStatus).toHaveBeenCalledTimes(2);
  });

  it("skips oids where getOrderStatus returns null", async () => {
    const hlClient = createMockHlClient({
      getHistoricalOrders: vi.fn().mockResolvedValue([]),
      getOrderStatus: vi.fn().mockResolvedValue(null),
    });

    const result = await resolveHistoricalStatuses(hlClient, "0xtest", [999]);

    expect(result.has(999)).toBe(false);
  });

  it("handles empty oids array without calling any API", async () => {
    const hlClient = createMockHlClient();

    const result = await resolveHistoricalStatuses(hlClient, "0xtest", []);

    expect(result.size).toBe(0);
    expect(hlClient.getHistoricalOrders).toHaveBeenCalledOnce();
    expect(hlClient.getOrderStatus).not.toHaveBeenCalled();
  });
});
