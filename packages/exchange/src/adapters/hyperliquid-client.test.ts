import { describe, it, expect, vi } from "vitest";
import type { HlClient, HlPosition } from "../types/hl-client.js";
import { HyperliquidClient } from "./hyperliquid-client.js";
import type { Hyperliquid } from "hyperliquid";

function createMockClient(): HlClient {
  const positions: HlPosition[] = [];
  return {
    connect: vi.fn(),
    getSzDecimals: vi.fn().mockReturnValue(5),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
    placeEntryOrder: vi.fn().mockResolvedValue({ orderId: "HL-E1", filledSize: 0.01, avgPrice: 95000, status: "placed" }),
    placeStopOrder: vi.fn().mockResolvedValue({ orderId: "HL-2", status: "placed" }),
    placeLimitOrder: vi.fn().mockResolvedValue({ orderId: "HL-3", status: "placed" }),
    cancelOrder: vi.fn(),
    getPositions: vi.fn().mockResolvedValue(positions),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getHistoricalOrders: vi.fn().mockResolvedValue([]),
    getOrderStatus: vi.fn().mockResolvedValue(null),
    getAccountEquity: vi.fn().mockResolvedValue(1000),
    getAccountState: vi.fn().mockResolvedValue({ accountValue: 1000, totalMarginUsed: 0, totalNtlPos: 0, totalRawUsd: 0, withdrawable: 1000, spotBalances: [] }),
    getMidPrice: vi.fn().mockResolvedValue(null),
  };
}

describe("HlClient interface (mock)", () => {
  it("places market order", async () => {
    const client = createMockClient();
    const result = await client.placeMarketOrder("BTC", true, 0.01);
    expect(result.orderId).toBe("HL-1");
    expect(client.placeMarketOrder).toHaveBeenCalledWith("BTC", true, 0.01);
  });

  it("places entry order (limit IOC)", async () => {
    const client = createMockClient();
    const result = await client.placeEntryOrder("BTC", true, 0.01, 95000, 10);
    expect(result.orderId).toBe("HL-E1");
    expect(result.filledSize).toBe(0.01);
    expect(result.avgPrice).toBe(95000);
    expect(client.placeEntryOrder).toHaveBeenCalledWith("BTC", true, 0.01, 95000, 10);
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

function createMockSdk(overrides: Record<string, unknown> = {}) {
  return {
    info: {
      perpetuals: {
        getClearinghouseState: vi.fn(),
        getMeta: vi.fn().mockResolvedValue({ universe: [] }),
      },
      spot: {
        getSpotClearinghouseState: vi.fn().mockResolvedValue({ balances: [] }),
      },
      getFrontendOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([]),
      getOrderStatus: vi.fn().mockResolvedValue({}),
    },
    exchange: {
      updateLeverage: vi.fn(),
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
    },
    custom: {
      marketOpen: vi.fn(),
    },
    ...overrides,
  } as unknown as Hyperliquid;
}

describe("HyperliquidClient.getSzDecimals", () => {
  it("returns 5 as default when no meta loaded", () => {
    const sdk = createMockSdk();
    const client = new HyperliquidClient(sdk);
    expect(client.getSzDecimals("BTC")).toBe(5);
  });

  it("returns cached value after loadSzDecimals", async () => {
    const sdk = createMockSdk();
    (sdk.info.perpetuals.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
      universe: [
        { name: "BTC", szDecimals: 4 },
        { name: "ETH", szDecimals: 3 },
      ],
    });
    const client = new HyperliquidClient(sdk);
    await client.loadSzDecimals("BTC");
    expect(client.getSzDecimals("BTC")).toBe(4);
    expect(client.getSzDecimals("ETH")).toBe(3);
  });

  it("returns 5 for unknown coin after meta loaded", async () => {
    const sdk = createMockSdk();
    (sdk.info.perpetuals.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
      universe: [{ name: "BTC", szDecimals: 4 }],
    });
    const client = new HyperliquidClient(sdk);
    await client.loadSzDecimals("BTC");
    expect(client.getSzDecimals("SOL")).toBe(5);
  });
});

describe("HyperliquidClient.placeEntryOrder", () => {
  it("sends limit IOC order with correct slippage (buy)", async () => {
    const sdk = createMockSdk();
    (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { oid: 42, totalSz: "0.01", avgPx: "95009.5" } }] } },
    });
    const client = new HyperliquidClient(sdk);

    const result = await client.placeEntryOrder("BTC", true, 0.01, 95000, 10);

    expect(result.orderId).toBe("42");
    expect(result.filledSize).toBe(0.01);
    expect(result.avgPrice).toBe(95009.5);
    expect(result.status).toBe("placed");

    // Verify SDK call: limit price = truncatePrice(95000 * 1.001) = 95095
    const call = (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.coin).toBe("BTC-PERP");
    expect(call.is_buy).toBe(true);
    expect(call.sz).toBe(0.01);
    expect(call.order_type).toEqual({ limit: { tif: "Ioc" } });
    expect(call.reduce_only).toBe(false);
    // Price should be slightly above current (buy slippage)
    expect(call.limit_px).toBeGreaterThan(95000);
  });

  it("sends limit IOC order with correct slippage (sell)", async () => {
    const sdk = createMockSdk();
    (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      response: { type: "order", data: { statuses: [{ filled: { oid: 43, totalSz: "0.01", avgPx: "94990" } }] } },
    });
    const client = new HyperliquidClient(sdk);

    const result = await client.placeEntryOrder("BTC", false, 0.01, 95000, 10);

    expect(result.filledSize).toBe(0.01);
    const call = (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.is_buy).toBe(false);
    // Price should be slightly below current (sell slippage)
    expect(call.limit_px).toBeLessThan(95000);
  });

  it("returns zero fill when no filled status", async () => {
    const sdk = createMockSdk();
    (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      response: { type: "order", data: { statuses: [{ resting: { oid: 44 } }] } },
    });
    const client = new HyperliquidClient(sdk);

    const result = await client.placeEntryOrder("BTC", true, 0.01, 95000, 10);

    expect(result.filledSize).toBe(0);
    expect(result.avgPrice).toBe(0);
    expect(result.orderId).toBe("44");
  });

  it("throws when size too small after truncation", async () => {
    const sdk = createMockSdk();
    (sdk.info.perpetuals.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
      universe: [{ name: "BTC", szDecimals: 0 }],
    });
    const client = new HyperliquidClient(sdk);
    await client.loadSzDecimals("BTC");

    await expect(client.placeEntryOrder("BTC", true, 0.5, 95000, 10))
      .rejects.toThrow("Size too small");
  });
});

describe("HyperliquidClient.fromSymbol normalization", () => {
  it("getPositions strips -PERP suffix from coin", async () => {
    const sdk = createMockSdk();
    (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
      assetPositions: [
        { position: { coin: "BTC-PERP", szi: "0.5", entryPx: "95000", unrealizedPnl: "10", leverage: { value: 5 }, liquidationPx: "80000" } },
      ],
    });

    const client = new HyperliquidClient(sdk);
    const positions = await client.getPositions("0xtest");

    expect(positions).toHaveLength(1);
    expect(positions[0].coin).toBe("BTC");
  });

  it("getPositions passes through plain coin unchanged", async () => {
    const sdk = createMockSdk();
    (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
      assetPositions: [
        { position: { coin: "BTC", szi: "0.5", entryPx: "95000", unrealizedPnl: "10", leverage: { value: 5 }, liquidationPx: null } },
      ],
    });

    const client = new HyperliquidClient(sdk);
    const positions = await client.getPositions("0xtest");

    expect(positions[0].coin).toBe("BTC");
  });

  it("getOpenOrders strips -PERP suffix from coin", async () => {
    const sdk = createMockSdk();
    (sdk.info.getFrontendOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { coin: "ETH-PERP", oid: "100", side: "buy", sz: "1.0", limitPx: "3500" },
    ]);

    const client = new HyperliquidClient(sdk);
    const orders = await client.getOpenOrders("0xtest");

    expect(orders).toHaveLength(1);
    expect(orders[0].coin).toBe("ETH");
  });

  it("getOpenOrders passes through plain coin unchanged", async () => {
    const sdk = createMockSdk();
    (sdk.info.getFrontendOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
      { coin: "ETH", oid: "100", side: "buy", sz: "1.0", limitPx: "3500" },
    ]);

    const client = new HyperliquidClient(sdk);
    const orders = await client.getOpenOrders("0xtest");

    expect(orders[0].coin).toBe("ETH");
  });
});

describe("HyperliquidClient input validation", () => {
  describe("getPositions", () => {
    it("skips positions with NaN entryPx", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: "0.01", entryPx: "not-a-number", unrealizedPnl: "5", leverage: { value: 5 }, liquidationPx: null } },
          { position: { coin: "ETH", szi: "1.0", entryPx: "3500", unrealizedPnl: "10", leverage: { value: 3 }, liquidationPx: "2800" } },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const positions = await client.getPositions("0xtest");

      expect(positions).toHaveLength(1);
      expect(positions[0].coin).toBe("ETH");
    });

    it("skips positions with undefined szi", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: undefined, entryPx: "95000", unrealizedPnl: "5", leverage: 5, liquidationPx: null } },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const positions = await client.getPositions("0xtest");

      expect(positions).toHaveLength(0);
    });

    it("skips positions with Infinity unrealizedPnl", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: "0.01", entryPx: "95000", unrealizedPnl: "Infinity", leverage: 5, liquidationPx: null } },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const positions = await client.getPositions("0xtest");

      expect(positions).toHaveLength(0);
    });

    it("falls back to leverage=1 when leverage is NaN", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: "0.01", entryPx: "95000", unrealizedPnl: "5", leverage: "invalid", liquidationPx: null } },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const positions = await client.getPositions("0xtest");

      expect(positions).toHaveLength(1);
      expect(positions[0].leverage).toBe(1);
    });

    it("parses valid positions correctly", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: "-0.5", entryPx: "95000", unrealizedPnl: "-100", leverage: { value: 10 }, liquidationPx: "100000" } },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const positions = await client.getPositions("0xtest");

      expect(positions).toHaveLength(1);
      expect(positions[0]).toEqual({
        coin: "BTC",
        direction: "short",
        size: 0.5,
        entryPrice: 95000,
        unrealizedPnl: -100,
        leverage: 10,
        liquidationPx: 100000,
      });
    });
  });

  describe("getOpenOrders", () => {
    it("skips orders with invalid oid", async () => {
      const sdk = createMockSdk();
      (sdk.info.getFrontendOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { coin: "BTC", oid: "abc", side: "buy", sz: "0.01", limitPx: "95000" },
        { coin: "ETH", oid: "123", side: "sell", sz: "1.0", limitPx: "3500" },
      ]);

      const client = new HyperliquidClient(sdk);
      const orders = await client.getOpenOrders("0xtest");

      expect(orders).toHaveLength(1);
      expect(orders[0].coin).toBe("ETH");
    });

    it("uses fallback for NaN sz and triggerPx", async () => {
      const sdk = createMockSdk();
      (sdk.info.getFrontendOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { coin: "BTC", oid: "100", side: "buy", sz: "not-a-number", limitPx: "95000", triggerPx: undefined },
      ]);

      const client = new HyperliquidClient(sdk);
      const orders = await client.getOpenOrders("0xtest");

      expect(orders).toHaveLength(1);
      expect(orders[0].sz).toBe(0);
      expect(orders[0].triggerPx).toBe(0);
    });
  });

  describe("getOrderStatus", () => {
    it("returns order status for triggered order", async () => {
      const sdk = createMockSdk();
      (sdk.info.getOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        order: { coin: "BTC-PERP", oid: 12345 },
        status: "triggered",
      });

      const client = new HyperliquidClient(sdk);
      const result = await client.getOrderStatus("0xtest", 12345);

      expect(result).toEqual({ oid: 12345, status: "triggered" });
    });

    it("returns null when SDK returns empty object", async () => {
      const sdk = createMockSdk();
      (sdk.info.getOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const client = new HyperliquidClient(sdk);
      const result = await client.getOrderStatus("0xtest", 99999);

      expect(result).toBeNull();
    });

    it("returns null when SDK throws", async () => {
      const sdk = createMockSdk();
      (sdk.info.getOrderStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Not found"));

      const client = new HyperliquidClient(sdk);
      const result = await client.getOrderStatus("0xtest", 99999);

      expect(result).toBeNull();
    });
  });

  describe("placeStopOrder reduceOnly skips truncateSize", () => {
    it("sends exact size when reduceOnly=true (no truncation)", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        universe: [{ name: "BTC", szDecimals: 4 }],
      });
      (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 55 } }] } },
      });
      const client = new HyperliquidClient(sdk);
      await client.loadSzDecimals("BTC");

      // 0.12345 has 5 decimals but szDecimals=4 → truncateSize would floor to 0.1234
      await client.placeStopOrder("BTC", true, 0.12345, 90000, true);

      const call = (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.sz).toBe(0.12345);
      expect(call.reduce_only).toBe(true);
    });

    it("truncates size when reduceOnly=false", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        universe: [{ name: "BTC", szDecimals: 4 }],
      });
      (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 56 } }] } },
      });
      const client = new HyperliquidClient(sdk);
      await client.loadSzDecimals("BTC");

      await client.placeStopOrder("BTC", true, 0.12345, 90000, false);

      const call = (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.sz).toBe(0.1234);
      expect(call.reduce_only).toBe(false);
    });
  });

  describe("placeLimitOrder reduceOnly skips truncateSize", () => {
    it("sends exact size when reduceOnly=true (no truncation)", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        universe: [{ name: "ETH", szDecimals: 3 }],
      });
      (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 57 } }] } },
      });
      const client = new HyperliquidClient(sdk);
      await client.loadSzDecimals("ETH");

      // 1.2345 has 4 decimals but szDecimals=3 → truncateSize would floor to 1.234
      await client.placeLimitOrder("ETH", false, 1.2345, 3500, true);

      const call = (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.sz).toBe(1.2345);
      expect(call.reduce_only).toBe(true);
    });

    it("truncates size when reduceOnly=false", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        universe: [{ name: "ETH", szDecimals: 3 }],
      });
      (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 58 } }] } },
      });
      const client = new HyperliquidClient(sdk);
      await client.loadSzDecimals("ETH");

      await client.placeLimitOrder("ETH", false, 1.2345, 3500, false);

      const call = (sdk.exchange.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.sz).toBe(1.234);
      expect(call.reduce_only).toBe(false);
    });
  });

  describe("getAccountEquity", () => {
    it("returns 0 when accountValue is NaN", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "garbage" },
      });

      const client = new HyperliquidClient(sdk);
      const equity = await client.getAccountEquity("0xtest");

      expect(equity).toBe(0);
    });

    it("returns 0 when marginSummary is missing", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const client = new HyperliquidClient(sdk);
      const equity = await client.getAccountEquity("0xtest");

      expect(equity).toBe(0);
    });

    it("returns valid equity", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "1234.56" },
      });

      const client = new HyperliquidClient(sdk);
      const equity = await client.getAccountEquity("0xtest");

      expect(equity).toBe(1234.56);
    });

    it("includes free spot USDC in equity (hold=0 means not in perps)", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "100" },
      });
      (sdk.info.spot.getSpotClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        balances: [{ coin: "USDC-SPOT", total: "15", hold: "0" }],
      });

      const client = new HyperliquidClient(sdk);
      const equity = await client.getAccountEquity("0xtest");

      expect(equity).toBe(115);
    });

    it("does not double-count spot USDC held as perps collateral", async () => {
      const sdk = createMockSdk();
      // Perps accountValue=16 already includes the USDC used as collateral
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "16" },
      });
      // Spot shows total=16, hold=16 (all held as perps collateral)
      (sdk.info.spot.getSpotClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        balances: [{ coin: "USDC", total: "16", hold: "16" }],
      });

      const client = new HyperliquidClient(sdk);
      const equity = await client.getAccountEquity("0xtest");

      // Should be 16, not 32 — hold is already in perps accountValue
      expect(equity).toBe(16);
    });
  });

  describe("getPositions isSanePrice branch", () => {
    it("skips position with entryPx=0 (fails isSanePrice)", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: "0.01", entryPx: "0", unrealizedPnl: "5", leverage: { value: 5 }, liquidationPx: null } },
          { position: { coin: "ETH", szi: "1.0", entryPx: "3500", unrealizedPnl: "10", leverage: { value: 3 }, liquidationPx: "2800" } },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const positions = await client.getPositions("0xtest");

      expect(positions).toHaveLength(1);
      expect(positions[0].coin).toBe("ETH");
    });

    it("skips position with entryPx=-100 (fails isSanePrice)", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: "0.5", entryPx: "-100", unrealizedPnl: "0", leverage: { value: 5 }, liquidationPx: null } },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const positions = await client.getPositions("0xtest");

      expect(positions).toHaveLength(0);
    });
  });

  describe("getHistoricalOrders", () => {
    it("parses orders with inner.oid", async () => {
      const sdk = createMockSdk();
      (sdk.info.getHistoricalOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { order: { oid: 100, coin: "BTC" }, status: "filled" },
        { order: { oid: 200, coin: "ETH" }, status: "cancelled" },
      ]);

      const client = new HyperliquidClient(sdk);
      const orders = await client.getHistoricalOrders("0xtest");

      expect(orders).toHaveLength(2);
      expect(orders[0]).toEqual({ oid: 100, status: "filled" });
      expect(orders[1]).toEqual({ oid: 200, status: "cancelled" });
    });

    it("falls back to o.oid when inner.oid is missing", async () => {
      const sdk = createMockSdk();
      (sdk.info.getHistoricalOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { oid: 300, status: "triggered" },
      ]);

      const client = new HyperliquidClient(sdk);
      const orders = await client.getHistoricalOrders("0xtest");

      expect(orders).toHaveLength(1);
      expect(orders[0]).toEqual({ oid: 300, status: "triggered" });
    });

    it("defaults status to 'open' when missing", async () => {
      const sdk = createMockSdk();
      (sdk.info.getHistoricalOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { order: { oid: 400 } },
      ]);

      const client = new HyperliquidClient(sdk);
      const orders = await client.getHistoricalOrders("0xtest");

      expect(orders).toHaveLength(1);
      expect(orders[0].status).toBe("open");
    });

    it("returns empty array when SDK returns null/undefined", async () => {
      const sdk = createMockSdk();
      (sdk.info.getHistoricalOrders as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const client = new HyperliquidClient(sdk);
      const orders = await client.getHistoricalOrders("0xtest");

      expect(orders).toEqual([]);
    });
  });

  describe("getMidPrice", () => {
    it("returns price for valid coin", async () => {
      const sdk = createMockSdk();
      sdk.info.getAllMids = vi.fn().mockResolvedValue({ "BTC-PERP": "95123.5" });

      const client = new HyperliquidClient(sdk);
      const price = await client.getMidPrice("BTC");

      expect(price).toBe(95123.5);
    });

    it("returns null for unknown coin", async () => {
      const sdk = createMockSdk();
      sdk.info.getAllMids = vi.fn().mockResolvedValue({ "BTC-PERP": "95000" });

      const client = new HyperliquidClient(sdk);
      const price = await client.getMidPrice("XYZ");

      expect(price).toBeNull();
    });

    it("returns null when SDK throws", async () => {
      const sdk = createMockSdk();
      sdk.info.getAllMids = vi.fn().mockRejectedValue(new Error("Network error"));

      const client = new HyperliquidClient(sdk);
      const price = await client.getMidPrice("BTC");

      expect(price).toBeNull();
    });

    it("returns null for non-positive price", async () => {
      const sdk = createMockSdk();
      sdk.info.getAllMids = vi.fn().mockResolvedValue({ "BTC-PERP": "0" });

      const client = new HyperliquidClient(sdk);
      const price = await client.getMidPrice("BTC");

      expect(price).toBeNull();
    });
  });

  describe("getAccountState", () => {
    it("returns full account state with perp + spot data", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "1000", totalMarginUsed: "200", totalNtlPos: "950", totalRawUsd: "800" },
        withdrawable: "750",
      });
      (sdk.info.spot.getSpotClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        balances: [
          { coin: "USDC", total: "50", hold: "10" },
          { coin: "ETH-SPOT", total: "2.5", hold: "0" },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const state = await client.getAccountState("0xtest");

      // accountValue = perpEquity(1000) + freeSpotUsdc(50-10=40)
      expect(state.accountValue).toBe(1040);
      expect(state.totalMarginUsed).toBe(200);
      expect(state.totalNtlPos).toBe(950);
      expect(state.totalRawUsd).toBe(800);
      // withdrawable = perp(750) + freeSpotUsdc(40)
      expect(state.withdrawable).toBe(790);
      expect(state.spotBalances).toHaveLength(2);
      expect(state.spotBalances[0]).toEqual({ coin: "USDC", total: 50, hold: 10 });
      expect(state.spotBalances[1]).toEqual({ coin: "ETH-SPOT", total: 2.5, hold: 0 });
    });

    it("handles missing marginSummary gracefully", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (sdk.info.spot.getSpotClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({ balances: [] });

      const client = new HyperliquidClient(sdk);
      const state = await client.getAccountState("0xtest");

      expect(state.accountValue).toBe(0);
      expect(state.totalMarginUsed).toBe(0);
      expect(state.withdrawable).toBe(0);
    });

    it("skips spot balances with total=0", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "500" },
        withdrawable: "400",
      });
      (sdk.info.spot.getSpotClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        balances: [
          { coin: "USDC", total: "100", hold: "0" },
          { coin: "ETH-SPOT", total: "0", hold: "0" },
        ],
      });

      const client = new HyperliquidClient(sdk);
      const state = await client.getAccountState("0xtest");

      expect(state.spotBalances).toHaveLength(1);
      expect(state.spotBalances[0].coin).toBe("USDC");
    });

    it("prevents double-counting of spot USDC held as collateral", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "500", totalMarginUsed: "100", totalNtlPos: "0", totalRawUsd: "0" },
        withdrawable: "400",
      });
      (sdk.info.spot.getSpotClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        balances: [{ coin: "USDC", total: "500", hold: "500" }],
      });

      const client = new HyperliquidClient(sdk);
      const state = await client.getAccountState("0xtest");

      // freeSpotUsdc = max(0, 500-500) = 0 → no double-counting
      expect(state.accountValue).toBe(500);
      expect(state.withdrawable).toBe(400);
    });

    it("handles spot API failure gracefully", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        marginSummary: { accountValue: "1000", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "0" },
        withdrawable: "1000",
      });
      (sdk.info.spot.getSpotClearinghouseState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Spot API down"));

      const client = new HyperliquidClient(sdk);
      const state = await client.getAccountState("0xtest");

      expect(state.accountValue).toBe(1000);
      expect(state.spotBalances).toEqual([]);
    });
  });
});
