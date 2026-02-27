import { describe, it, expect, vi } from "vitest";
import type { HlClient, HlPosition } from "./hyperliquid-client.js";
import { HyperliquidClient } from "./hyperliquid-client.js";
import type { Hyperliquid } from "hyperliquid";

function createMockClient(): HlClient {
  const positions: HlPosition[] = [];
  return {
    connect: vi.fn(),
    getSzDecimals: vi.fn().mockReturnValue(5),
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

function createMockSdk(overrides: Record<string, unknown> = {}) {
  return {
    info: {
      perpetuals: {
        getClearinghouseState: vi.fn(),
        getMeta: vi.fn().mockResolvedValue({ universe: [] }),
      },
      getFrontendOpenOrders: vi.fn().mockResolvedValue([]),
      getHistoricalOrders: vi.fn().mockResolvedValue([]),
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

describe("HyperliquidClient input validation", () => {
  describe("getPositions", () => {
    it("skips positions with NaN entryPx", async () => {
      const sdk = createMockSdk();
      (sdk.info.perpetuals.getClearinghouseState as ReturnType<typeof vi.fn>).mockResolvedValue({
        assetPositions: [
          { position: { coin: "BTC", szi: "0.01", entryPx: "not-a-number", unrealizedPnl: "5", leverage: { value: 5 } } },
          { position: { coin: "ETH", szi: "1.0", entryPx: "3500", unrealizedPnl: "10", leverage: { value: 3 } } },
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
          { position: { coin: "BTC", szi: undefined, entryPx: "95000", unrealizedPnl: "5", leverage: 5 } },
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
          { position: { coin: "BTC", szi: "0.01", entryPx: "95000", unrealizedPnl: "Infinity", leverage: 5 } },
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
          { position: { coin: "BTC", szi: "0.01", entryPx: "95000", unrealizedPnl: "5", leverage: "invalid" } },
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
          { position: { coin: "BTC", szi: "-0.5", entryPx: "95000", unrealizedPnl: "-100", leverage: { value: 10 } } },
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
  });
});
