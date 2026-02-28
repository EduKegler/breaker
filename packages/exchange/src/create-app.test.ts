import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp, type ServerDeps } from "./create-app.js";
import { PositionBook } from "./domain/position-book.js";
import { SqliteStore } from "./adapters/sqlite-store.js";
import type { ExchangeConfig } from "./types/config.js";
import type { Strategy } from "@breaker/backtest";

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

let store: SqliteStore;
let deps: ServerDeps;

beforeEach(() => {
  store = new SqliteStore(":memory:");
  const positionBook = new PositionBook();
  const hlClient = {
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
    getAccountState: vi.fn().mockResolvedValue({
      accountValue: 1000,
      totalMarginUsed: 200,
      totalNtlPos: 950,
      totalRawUsd: 800,
      withdrawable: 750,
      spotBalances: [{ coin: "USDC", total: 50, hold: 0 }],
    }),
  };

  deps = {
    config,
    store,
    positionBook,
    hlClient,
    walletAddress: "0xtest1234",
    signalHandlerDeps: {
      config,
      hlClient,
      store,
      eventLog: { append: vi.fn() },
      alertsClient: { notifyPositionOpened: vi.fn(), notifyTrailingSlMoved: vi.fn(), sendText: vi.fn() },
      positionBook,
    },
    streamer: {
      getCandles: vi.fn().mockReturnValue([]),
      getLatest: vi.fn().mockReturnValue(null),
      warmup: vi.fn().mockResolvedValue([]),
      start: vi.fn(),
      stop: vi.fn(),
      fetchHistorical: vi.fn().mockResolvedValue([]),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    } as unknown as ServerDeps["streamer"],
    strategyFactory: () => ({
      name: "test-strategy",
      params: {},
      onCandle: () => null,
    }) as Strategy,
  };
});

afterEach(() => {
  store.close();
});

describe("Exchange server", () => {
  it("GET /health returns status and config", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.mode).toBe("testnet");
    expect(res.body.asset).toBe("BTC");
    expect(res.body.strategy).toBe("donchian-adx");
    expect(res.body.lastCandleAt).toBeNull();
  });

  it("GET /health reports stale when candle data is old", async () => {
    // 90 min ago — older than 5 × 15m = 75 min threshold
    const oldTimestamp = Date.now() - 90 * 60 * 1000;
    (deps.streamer.getLatest as ReturnType<typeof vi.fn>).mockReturnValue({ t: oldTimestamp });

    const app = createApp(deps);
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stale");
    expect(res.body.lastCandleAt).toBe(oldTimestamp);
  });

  it("GET /health reports ok when candle data is fresh", async () => {
    const recentTimestamp = Date.now() - 60_000; // 1 min ago
    (deps.streamer.getLatest as ReturnType<typeof vi.fn>).mockReturnValue({ t: recentTimestamp });

    const app = createApp(deps);
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.lastCandleAt).toBe(recentTimestamp);
  });

  it("GET /positions returns empty when no positions", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/positions");

    expect(res.status).toBe(200);
    expect(res.body.positions).toEqual([]);
  });

  it("GET /orders returns empty when no orders", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/orders");

    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  it("GET /equity returns empty when no snapshots", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/equity");

    expect(res.status).toBe(200);
    expect(res.body.snapshots).toEqual([]);
  });

  it("GET /account returns wallet and margin data", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/account");

    expect(res.status).toBe(200);
    expect(res.body.walletAddress).toBe("0xtest1234");
    expect(res.body.accountValue).toBe(1000);
    expect(res.body.totalMarginUsed).toBe(200);
    expect(res.body.totalNtlPos).toBe(950);
    expect(res.body.totalRawUsd).toBe(800);
    expect(res.body.withdrawable).toBe(750);
    expect(res.body.spotBalances).toEqual([{ coin: "USDC", total: 50, hold: 0 }]);
  });

  it("GET /account returns 500 on API failure", async () => {
    (deps.hlClient.getAccountState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HL down"));

    const app = createApp(deps);
    const res = await request(app).get("/account");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("HL down");
  });

  it("GET /config returns exchange config", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/config");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("testnet");
    expect(res.body.leverage).toBe(5);
    expect(res.body.guardrails).toBeDefined();
  });

  it("POST /signal accepts valid signal and executes", async () => {
    // Poller returns latest candle for currentPrice resolution
    (deps.streamer.getLatest as ReturnType<typeof vi.fn>).mockReturnValue({ c: 95000 });

    const app = createApp(deps);
    const res = await request(app)
      .post("/signal")
      .send({
        direction: "long",
        entryPrice: 95000,
        stopLoss: 94000,
        takeProfits: [{ price: 97000, pctOfPosition: 0.5 }],
        comment: "Manual entry",
        alertId: "manual-001",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
    expect(res.body.signalId).toBe(1);
  });

  it("POST /signal rejects when no market price and entryPrice is null", async () => {
    // Poller returns null (no candles loaded yet)
    (deps.streamer.getLatest as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const app = createApp(deps);
    const res = await request(app)
      .post("/signal")
      .send({
        direction: "long",
        entryPrice: null,
        stopLoss: 94000,
        alertId: "no-price-001",
      });

    expect(res.status).toBe(422);
    expect(res.body.reason).toContain("No market price");
  });

  it("POST /signal uses entryPrice as fallback when poller has no data", async () => {
    (deps.streamer.getLatest as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const app = createApp(deps);
    const res = await request(app)
      .post("/signal")
      .send({
        direction: "long",
        entryPrice: 95000,
        stopLoss: 94000,
        alertId: "fallback-001",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
  });

  it("GET /open-orders returns orders from Hyperliquid", async () => {
    const mockOrders = [
      { coin: "BTC", oid: 123, side: "A", sz: 0.01, limitPx: 94000, orderType: "Stop Market", isTrigger: true, triggerPx: 94000, triggerCondition: "lt", reduceOnly: true, isPositionTpsl: true },
      { coin: "BTC", oid: 456, side: "A", sz: 0.005, limitPx: 97000, orderType: "Limit", isTrigger: false, triggerPx: 0, triggerCondition: "", reduceOnly: true, isPositionTpsl: true },
    ];
    (deps.hlClient.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue(mockOrders);

    const app = createApp(deps);
    const res = await request(app).get("/open-orders");

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(2);
    expect(res.body.orders[0].coin).toBe("BTC");
    expect(deps.hlClient.getOpenOrders).toHaveBeenCalledWith("0xtest1234");
  });

  it("GET /open-orders returns 500 on API failure", async () => {
    (deps.hlClient.getOpenOrders as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HL down"));

    const app = createApp(deps);
    const res = await request(app).get("/open-orders");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("HL down");
  });

  it("GET /candles returns full candle history", async () => {
    const mockCandles = [
      { t: 1700000000000, o: 95000, h: 95500, l: 94500, c: 95200, v: 1000, n: 50 },
      { t: 1700000900000, o: 95200, h: 95700, l: 95000, c: 95400, v: 800, n: 40 },
    ];
    (deps.streamer.fetchHistorical as ReturnType<typeof vi.fn>).mockResolvedValue(mockCandles);

    const app = createApp(deps);
    const res = await request(app).get("/candles");

    expect(res.status).toBe(200);
    expect(res.body.candles).toHaveLength(2);
    expect(res.body.candles[0].t).toBe(1700000000000);
  });

  it("GET /candles returns empty when no candles", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/candles");

    expect(res.status).toBe(200);
    expect(res.body.candles).toEqual([]);
  });

  it("GET /candles uses candleCache when available", async () => {
    const mockCandles = [
      { t: 1700000000000, o: 95000, h: 95500, l: 94500, c: 95200, v: 1000, n: 50 },
    ];
    deps.candleCache = {
      sync: vi.fn().mockResolvedValue({ fetched: 0, cached: 1 }),
      getCandles: vi.fn().mockReturnValue(mockCandles),
      close: vi.fn(),
    } as any;

    const app = createApp(deps);
    const res = await request(app).get("/candles");

    expect(res.status).toBe(200);
    expect(res.body.candles).toHaveLength(1);
    expect(deps.candleCache!.sync).toHaveBeenCalled();
    expect(deps.candleCache!.getCandles).toHaveBeenCalled();
    expect(deps.streamer.fetchHistorical).not.toHaveBeenCalled();
  });

  it("GET /signals returns recent signals from store", async () => {
    store.insertSignal({
      alert_id: "sig-001",
      source: "strategy-runner",
      asset: "BTC",
      side: "LONG",
      entry_price: 95000,
      stop_loss: 94000,
      take_profits: JSON.stringify([{ price: 97000, pctOfPosition: 0.5 }]),
      risk_check_passed: 1,
      risk_check_reason: null,
    });

    const app = createApp(deps);
    const res = await request(app).get("/signals");

    expect(res.status).toBe(200);
    expect(res.body.signals).toHaveLength(1);
    expect(res.body.signals[0].alert_id).toBe("sig-001");
    expect(res.body.signals[0].side).toBe("LONG");
  });

  it("GET /signals returns empty when no signals", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/signals");

    expect(res.status).toBe(200);
    expect(res.body.signals).toEqual([]);
  });

  it("GET /strategy-signals fetches historical candles for replay warmup", async () => {
    const candles = Array.from({ length: 20 }, (_, i) => ({
      t: 1700000000000 + i * 900_000,
      o: 95000 + i * 10,
      h: 95500 + i * 10,
      l: 94500 + i * 10,
      c: 95200 + i * 10,
      v: 1000,
      n: 50,
    }));
    (deps.streamer.fetchHistorical as ReturnType<typeof vi.fn>).mockResolvedValue(candles);

    deps.strategyFactory = () => ({
      name: "test-strategy",
      params: {},
      onCandle: (ctx) => {
        if (ctx.index === 5) {
          return { direction: "long", entryPrice: 95250, stopLoss: 94550, takeProfits: [], comment: "test" };
        }
        return null;
      },
    }) as Strategy;

    const app = createApp(deps);
    const res = await request(app).get("/strategy-signals");

    expect(res.status).toBe(200);
    expect(res.body.signals).toHaveLength(1);
    expect(res.body.signals[0].direction).toBe("long");
    expect(res.body.signals[0].t).toBe(candles[5].t);
    // Falls back to fetchHistorical when no candleCache
    expect(deps.streamer.fetchHistorical).toHaveBeenCalled();
  });

  it("GET /strategy-signals returns empty when no candles", async () => {
    (deps.streamer.fetchHistorical as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const app = createApp(deps);
    const res = await request(app).get("/strategy-signals");

    expect(res.status).toBe(200);
    expect(res.body.signals).toEqual([]);
  });

  it("GET /strategy-signals caches result with TTL", async () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      t: 1700000000000 + i * 900_000,
      o: 95000, h: 95500, l: 94500, c: 95200, v: 1000, n: 50,
    }));
    (deps.streamer.fetchHistorical as ReturnType<typeof vi.fn>).mockResolvedValue(candles);

    const app = createApp(deps);
    await request(app).get("/strategy-signals");
    await request(app).get("/strategy-signals");

    // fetchHistorical should only be called once (second call uses TTL cache)
    expect(deps.streamer.fetchHistorical).toHaveBeenCalledTimes(1);
  });

  it("GET /strategy-signals uses candleCache when available", async () => {
    const candles = Array.from({ length: 10 }, (_, i) => ({
      t: 1700000000000 + i * 900_000,
      o: 95000, h: 95500, l: 94500, c: 95200, v: 1000, n: 50,
    }));
    deps.candleCache = {
      sync: vi.fn().mockResolvedValue({ fetched: 0, cached: 10 }),
      getCandles: vi.fn().mockReturnValue(candles),
      close: vi.fn(),
    } as any;

    const app = createApp(deps);
    const res = await request(app).get("/strategy-signals");

    expect(res.status).toBe(200);
    expect(deps.candleCache!.sync).toHaveBeenCalled();
    expect(deps.candleCache!.getCandles).toHaveBeenCalled();
    // Should NOT use streamer.fetchHistorical when cache is available
    expect(deps.streamer.fetchHistorical).not.toHaveBeenCalled();
  });

  it("POST /close-position closes position and cancels coin orders", async () => {
    // Open a position first
    deps.positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      liquidationPx: null,
      trailingStopLoss: null,
      openedAt: new Date().toISOString(),
      signalId: 1,
    });

    // Mock open orders: 2 for BTC, 1 for ETH (should not cancel ETH)
    const mockOrders = [
      { coin: "BTC", oid: 100, side: "A", sz: 0.01, limitPx: 94000, orderType: "Stop Market", isTrigger: true, triggerPx: 94000, triggerCondition: "lt", reduceOnly: true, isPositionTpsl: true },
      { coin: "BTC", oid: 101, side: "A", sz: 0.005, limitPx: 97000, orderType: "Limit", isTrigger: false, triggerPx: 0, triggerCondition: "", reduceOnly: true, isPositionTpsl: false },
      { coin: "ETH", oid: 200, side: "B", sz: 0.1, limitPx: 3000, orderType: "Limit", isTrigger: false, triggerPx: 0, triggerCondition: "", reduceOnly: false, isPositionTpsl: false },
    ];
    (deps.hlClient.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue(mockOrders);

    const onSignalProcessed = vi.fn();
    deps.signalHandlerDeps.onSignalProcessed = onSignalProcessed;

    const app = createApp(deps);
    const res = await request(app)
      .post("/close-position")
      .send({ coin: "BTC" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("closed");

    // Should place market order on opposite side (sell for long)
    expect(deps.hlClient.placeMarketOrder).toHaveBeenCalledWith("BTC", false, 0.01);

    // Should cancel only BTC orders (oid 100, 101), not ETH (200)
    expect(deps.hlClient.cancelOrder).toHaveBeenCalledTimes(2);
    expect(deps.hlClient.cancelOrder).toHaveBeenCalledWith("BTC", 100);
    expect(deps.hlClient.cancelOrder).toHaveBeenCalledWith("BTC", 101);

    // Position book should be cleared
    expect(deps.positionBook.get("BTC")).toBeNull();

    // WS broadcast should be triggered
    expect(onSignalProcessed).toHaveBeenCalled();
  });

  it("POST /close-position returns 400 if no position", async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post("/close-position")
      .send({ coin: "BTC" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No open position");
  });

  it("POST /close-position returns 400 for missing coin", async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post("/close-position")
      .send({});

    expect(res.status).toBe(400);
  });

  it("POST /close-position returns 409 when close already in progress", async () => {
    deps.positionBook.open({
      coin: "BTC",
      direction: "long",
      entryPrice: 95000,
      size: 0.01,
      stopLoss: 94000,
      takeProfits: [],
      liquidationPx: null,
      trailingStopLoss: null,
      openedAt: new Date().toISOString(),
      signalId: 1,
    });

    // Signal-based synchronization: resolveFirst completes the hanging order,
    // enteredPromise resolves when the handler reaches placeMarketOrder
    let resolveFirst!: () => void;
    let signalEntered!: () => void;
    const enteredPromise = new Promise<void>((r) => { signalEntered = r; });
    const hangingPromise = new Promise<{ orderId: string; status: string }>((resolve) => {
      resolveFirst = () => resolve({ orderId: "HL-1", status: "placed" });
    });
    (deps.hlClient.placeMarketOrder as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      signalEntered();
      return hangingPromise;
    });

    // Use a real HTTP server + native fetch for reliable concurrent requests
    const app = createApp(deps);
    const server = app.listen(0);
    const addr = server.address() as import("node:net").AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      // First request starts but hangs on placeMarketOrder
      const first = fetch(`${base}/close-position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coin: "BTC" }),
      });
      // Wait until the handler is actually inside placeMarketOrder
      await enteredPromise;

      // Second request should get 409
      const second = await fetch(`${base}/close-position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coin: "BTC" }),
      });
      expect(second.status).toBe(409);
      const secondBody = await second.json();
      expect(secondBody.error).toContain("already in progress");

      // Resolve the first request
      resolveFirst();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("DELETE /open-order/:oid cancels an order", async () => {
    const mockOrders = [
      { coin: "BTC", oid: 100, side: "A", sz: 0.01, limitPx: 94000, orderType: "Stop Market", isTrigger: true, triggerPx: 94000, triggerCondition: "lt", reduceOnly: true, isPositionTpsl: true },
    ];
    (deps.hlClient.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue(mockOrders);

    const onSignalProcessed = vi.fn();
    deps.signalHandlerDeps.onSignalProcessed = onSignalProcessed;

    const app = createApp(deps);
    const res = await request(app).delete("/open-order/100");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(deps.hlClient.cancelOrder).toHaveBeenCalledWith("BTC", 100);
    expect(onSignalProcessed).toHaveBeenCalled();
  });

  it("DELETE /open-order/:oid returns 404 if order not found", async () => {
    (deps.hlClient.getOpenOrders as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const app = createApp(deps);
    const res = await request(app).delete("/open-order/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("GET /config includes autoTradingEnabled", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/config");

    expect(res.status).toBe(200);
    expect(res.body.autoTradingEnabled).toBe(true);
  });

  it("POST /auto-trading enables auto-trading", async () => {
    deps.config.autoTradingEnabled = false;
    const app = createApp(deps);
    const res = await request(app)
      .post("/auto-trading")
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.autoTradingEnabled).toBe(true);
    expect(deps.config.autoTradingEnabled).toBe(true);
  });

  it("POST /auto-trading disables auto-trading", async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post("/auto-trading")
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.autoTradingEnabled).toBe(false);
    expect(deps.config.autoTradingEnabled).toBe(false);
  });

  it("POST /auto-trading rejects invalid payload", async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post("/auto-trading")
      .send({ enabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("enabled must be boolean");
  });

  it("POST /auto-trading rejects missing payload", async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post("/auto-trading")
      .send({});

    expect(res.status).toBe(400);
  });

  it("POST /signal rejects invalid payload", async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post("/signal")
      .send({ direction: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid");
  });

  it("POST /signal returns 422 for duplicate alertId", async () => {
    (deps.streamer.getLatest as ReturnType<typeof vi.fn>).mockReturnValue({ c: 95000 });

    const app = createApp(deps);

    await request(app).post("/signal").send({
      direction: "long",
      entryPrice: 95000,
      stopLoss: 94000,
      alertId: "dup-test",
    });

    const res = await request(app).post("/signal").send({
      direction: "long",
      entryPrice: 95000,
      stopLoss: 94000,
      alertId: "dup-test",
    });

    expect(res.status).toBe(422);
    expect(res.body.reason).toContain("Duplicate");
  });
});
