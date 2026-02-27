import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp, type ServerDeps } from "./server.js";
import { PositionBook } from "./domain/position-book.js";
import { SqliteStore } from "./adapters/sqlite-store.js";
import type { ExchangeConfig } from "./types/config.js";

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

let store: SqliteStore;
let deps: ServerDeps;

beforeEach(() => {
  store = new SqliteStore(":memory:");
  const positionBook = new PositionBook();
  const hlClient = {
    connect: vi.fn(),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn().mockResolvedValue({ orderId: "HL-1", status: "placed" }),
    placeStopOrder: vi.fn().mockResolvedValue({ orderId: "HL-2", status: "placed" }),
    placeLimitOrder: vi.fn().mockResolvedValue({ orderId: "HL-3", status: "placed" }),
    cancelOrder: vi.fn(),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getHistoricalOrders: vi.fn().mockResolvedValue([]),
    getAccountEquity: vi.fn().mockResolvedValue(1000),
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
      alertsClient: { notifyPositionOpened: vi.fn() },
      positionBook,
    },
    candlePoller: {
      getCandles: vi.fn().mockReturnValue([]),
      getLatest: vi.fn().mockReturnValue(null),
      warmup: vi.fn().mockResolvedValue([]),
      poll: vi.fn().mockResolvedValue(null),
    } as unknown as ServerDeps["candlePoller"],
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

  it("GET /config returns exchange config", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/config");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("testnet");
    expect(res.body.leverage).toBe(5);
    expect(res.body.guardrails).toBeDefined();
  });

  it("POST /signal accepts valid signal and executes", async () => {
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

  it("GET /candles returns candles from poller", async () => {
    const mockCandles = [
      { t: 1700000000000, o: 95000, h: 95500, l: 94500, c: 95200, v: 1000, n: 50 },
      { t: 1700000900000, o: 95200, h: 95700, l: 95000, c: 95400, v: 800, n: 40 },
    ];
    (deps.candlePoller.getCandles as ReturnType<typeof vi.fn>).mockReturnValue(mockCandles);

    const app = createApp(deps);
    const res = await request(app).get("/candles");

    expect(res.status).toBe(200);
    expect(res.body.candles).toHaveLength(2);
    expect(res.body.candles[0].t).toBe(1700000000000);
    expect(deps.candlePoller.getCandles).toHaveBeenCalled();
  });

  it("GET /candles returns empty when no candles", async () => {
    const app = createApp(deps);
    const res = await request(app).get("/candles");

    expect(res.status).toBe(200);
    expect(res.body.candles).toEqual([]);
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

  it("POST /signal rejects invalid payload", async () => {
    const app = createApp(deps);
    const res = await request(app)
      .post("/signal")
      .send({ direction: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid");
  });

  it("POST /signal returns 422 for duplicate alertId", async () => {
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
