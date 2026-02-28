import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { app } from "./server.js";
import type { DailyTradeLimit } from "../lib/daily-limit.js";
import { env } from "../lib/env.js";

// Mock external dependencies to isolate webhook handler tests
vi.mock("../lib/redis.js", () => ({
  redis: {
    init: vi.fn().mockResolvedValue({ configured: false, connected: false, dedupMode: "memory", reason: "not_configured" }),
    isAvailable: vi.fn().mockReturnValue(false),
    hasDedup: vi.fn().mockResolvedValue(false),
    setDedup: vi.fn().mockResolvedValue(false),
    getRuntimeState: vi.fn().mockReturnValue({ configured: false, connected: false, dedupMode: "memory" }),
  },
}));

vi.mock("got", () => ({
  default: {
    post: vi.fn().mockReturnValue({ json: vi.fn().mockResolvedValue({ status: "ok" }) }),
  },
}));

function validPayload(overrides?: Record<string, unknown>) {
  return {
    alert_id: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    event_type: "ENTRY",
    asset: "BTC",
    side: "LONG",
    entry: 95000,
    sl: 93000,
    qty: 0.01,
    ...overrides,
  };
}

describe("/send proxy route", () => {
  const originalSecret = env.WEBHOOK_SECRET;

  beforeEach(() => {
    env.WEBHOOK_SECRET = "";
  });

  afterEach(() => {
    env.WEBHOOK_SECRET = originalSecret;
  });

  it("POST /send/:token proxies text to WhatsApp", async () => {
    const res = await request(app)
      .post("/send/any-token")
      .send({ text: "hello from exchange" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "sent" });
  });

  it("POST /send/:token returns 403 with invalid token when secret is set", async () => {
    env.WEBHOOK_SECRET = "correct-secret";

    const res = await request(app)
      .post("/send/wrong-token")
      .send({ text: "hello" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "invalid token" });
  });

  it("POST /send/:token returns 200 with valid token when secret is set", async () => {
    env.WEBHOOK_SECRET = "my-secret";

    const res = await request(app)
      .post("/send/my-secret")
      .send({ text: "hello" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "sent" });
  });

  it("POST /send/:token returns 400 when text is missing", async () => {
    const res = await request(app)
      .post("/send/any-token")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "text required" });
  });

  it("POST /send/:token returns 400 when text is empty", async () => {
    const res = await request(app)
      .post("/send/any-token")
      .send({ text: "  " });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "text required" });
  });

  it("POST /send with body secret proxies text", async () => {
    env.WEBHOOK_SECRET = "body-secret";

    const res = await request(app)
      .post("/send")
      .send({ text: "hello via body auth", secret: "body-secret" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "sent" });
  });

  it("POST /send rejects invalid body secret", async () => {
    env.WEBHOOK_SECRET = "body-secret";

    const res = await request(app)
      .post("/send")
      .send({ text: "hello", secret: "wrong" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "invalid secret" });
  });
});

describe("webhook daily limit integration", () => {
  beforeEach(() => {
    // Reset daily limit counter between tests by recording to a fake day
    // We use fake timers to isolate each test
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-26T12:00:00Z"));
  });

  it("health endpoint shows trade count", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("trades_today");
    expect(res.body).toHaveProperty("trades_remaining");
    expect(res.body).toHaveProperty("trades_limit");
  });

  it("rejects signal when daily limit is reached", async () => {
    // Manually fill up the limit
    const dailyLimit = app.locals.dailyLimit as DailyTradeLimit;
    const limit = dailyLimit.getStatus().limit;
    for (let i = 0; i < limit; i++) {
      dailyLimit.record();
    }

    const res = await request(app)
      .post("/webhook")
      .send(validPayload());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(res.body.reason).toBe("global_daily_limit");
    expect(res.body.trades_today).toBe(limit);

    vi.useRealTimers();
  });
});
