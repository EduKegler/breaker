import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { app, dailyLimit } from "./server.js";

// Mock external dependencies to isolate webhook handler tests
vi.mock("../lib/redis.js", () => ({
  initRedis: vi.fn().mockResolvedValue({ configured: false, connected: false, dedupMode: "memory", reason: "not_configured" }),
  isRedisAvailable: vi.fn().mockReturnValue(false),
  redisHasDedup: vi.fn().mockResolvedValue(false),
  redisSetDedup: vi.fn().mockResolvedValue(false),
  getRedisRuntimeState: vi.fn().mockReturnValue({ configured: false, connected: false, dedupMode: "memory" }),
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
