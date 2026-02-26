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
    getAccountEquity: vi.fn().mockResolvedValue(1000),
  };

  deps = {
    config,
    store,
    positionBook,
    hlClient,
    signalHandlerDeps: {
      config,
      hlClient,
      store,
      eventLog: { append: vi.fn() },
      alertsClient: { notifyPositionOpened: vi.fn() },
      positionBook,
    },
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
