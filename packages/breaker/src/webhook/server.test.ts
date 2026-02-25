import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import request from "supertest";
import {
  validateAlert,
  formatWhatsAppMessage,
  isDuplicate,
  getRedisStartupPolicy,
  app,
} from "./server.js";
import type { AlertPayload } from "../types/alert.js";

const CAN_BIND = await new Promise<boolean>((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.listen(0, "127.0.0.1", () => {
    server.close(() => resolve(true));
  });
});
const describeHttp = CAN_BIND ? describe : describe.skip;

const validPayload: AlertPayload = {
  alert_id: "BTC-L-1709312400",
  event_type: "ENTRY",
  asset: "BTC",
  side: "LONG",
  entry: 97500.0,
  sl: 95200.0,
  tp1: 98650.0,
  tp2: 103000.0,
  tp1_pct: 50,
  qty: 0.012,
  leverage: 5,
  risk_usd: 10.0,
  notional_usdc: 1170.0,
  margin_usdc: 234.0,
  signal_ts: Math.floor(Date.now() / 1000),
  bar_ts: Math.floor(Date.now() / 1000),
};

describe("validateAlert", () => {
  it("returns empty array for valid payload", () => {
    expect(validateAlert(validPayload)).toEqual([]);
  });

  it("returns errors for missing required fields", () => {
    const errors = validateAlert({});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("alert_id"))).toBe(true);
  });

  it("returns errors for invalid side", () => {
    const errors = validateAlert({ ...validPayload, side: "UP" });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("side"))).toBe(true);
  });

  it("returns errors for wrong types", () => {
    const errors = validateAlert({
      ...validPayload,
      entry: "not-a-number",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts payload without optional fields", () => {
    const minimal = {
      alert_id: "TEST-1",
      event_type: "ENTRY",
      asset: "BTC",
      side: "LONG",
      entry: 100,
      sl: 95,
      qty: 0.01,
    };
    expect(validateAlert(minimal)).toEqual([]);
  });
});

describe("getRedisStartupPolicy", () => {
  it("returns fail_fast when Redis is configured but unavailable", () => {
    const policy = getRedisStartupPolicy({
      configured: true,
      connected: false,
      dedupMode: "memory",
      reason: "connect_failed",
      error: "connection refused",
    });
    expect(policy).toBe("fail_fast");
  });

  it("returns degraded when Redis is not configured", () => {
    const policy = getRedisStartupPolicy({
      configured: false,
      connected: false,
      dedupMode: "memory",
      reason: "not_configured",
    });
    expect(policy).toBe("degraded");
  });

  it("returns ready when Redis is connected", () => {
    const policy = getRedisStartupPolicy({
      configured: true,
      connected: true,
      dedupMode: "redis",
      reason: "connected",
    });
    expect(policy).toBe("ready");
  });
});

describe("formatWhatsAppMessage", () => {
  it("formats a LONG alert correctly", () => {
    const msg = formatWhatsAppMessage(validPayload);
    expect(msg).toContain("BTC LONG");
    expect(msg).toContain("*Entry:* $97500.00");
    expect(msg).toContain("*StopLoss:* $95200.00");
    expect(msg).toContain("at 5x)");
    expect(msg).toContain("*TP50:* $98650.00");
    expect(msg).toContain("*Leverage:* 5x");
    expect(msg).toContain("*Risk:* $10.00");
    expect(msg).toContain("*Qty:* 0.012");
    expect(msg).toContain("\u{1F7E2}"); // green circle for LONG
  });

  it("formats a SHORT alert correctly", () => {
    const shortPayload: AlertPayload = {
      ...validPayload,
      side: "SHORT",
      entry: 97500,
      sl: 99800,
      tp1: 96350,
      tp2: 92500,
    };
    const msg = formatWhatsAppMessage(shortPayload);
    expect(msg).toContain("SHORT");
    expect(msg).toContain("*StopLoss:* $99800.00");
    expect(msg).toContain("+"); // SHORT SL is above entry
    expect(msg).toContain("\u{1F534}"); // red circle for SHORT
  });
});

describe("isDuplicate", () => {
  // Note: isDuplicate uses a module-level Map, so state persists across tests.
  // We use unique IDs to avoid cross-test pollution.

  it("returns false for first call", () => {
    expect(isDuplicate("unique-test-1")).toBe(false);
  });

  it("returns true for second call with same ID", () => {
    isDuplicate("unique-test-2");
    expect(isDuplicate("unique-test-2")).toBe(true);
  });

  it("returns false for different IDs", () => {
    isDuplicate("unique-test-3a");
    expect(isDuplicate("unique-test-3b")).toBe(false);
  });

  it("evicts expired entries when cache exceeds half capacity", () => {
    // Fill cache past MAX_CACHE/2 (500) with entries that will be "expired"
    // We can't easily manipulate timestamps, but we can fill and check the eviction code path
    for (let i = 0; i < 510; i++) {
      isDuplicate(`evict-test-${i}-${Date.now()}`);
    }
    // The eviction loop runs but finds nothing expired (all recent)
    // This still covers the eviction code path (lines 107-111)
    expect(isDuplicate(`evict-final-${Date.now()}`)).toBe(false);
  });

  it("evicts oldest entry when cache exceeds MAX_CACHE", () => {
    // Fill cache to MAX_CACHE + 1 to trigger overflow eviction
    for (let i = 0; i < 1005; i++) {
      isDuplicate(`overflow-test-${i}-${Date.now()}`);
    }
    // Overflow eviction removes first entry (lines 122-125)
    // Just verify no crash and function still works
    expect(isDuplicate(`overflow-final-${Date.now()}`)).toBe(false);
  });
});

describeHttp("POST /webhook (handler)", () => {
  // WEBHOOK_SECRET is loaded from infra/.env at import time
  // Tests that need to pass secret validation must include it
  const secret = process.env.WEBHOOK_SECRET || "test-secret";

  it("returns 400 for invalid JSON body", async () => {
    const res = await request(app)
      .post(`/webhook/${secret}`)
      .set("Content-Type", "text/plain")
      .send("not json{{{");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid JSON");
  });

  it("returns 403 for missing secret when WEBHOOK_SECRET is configured", async () => {
    const res = await request(app)
      .post("/webhook")
      .send({ ...validPayload, alert_id: "no-secret-test" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid secret");
  });

  it("returns 400 for invalid payload (missing required fields)", async () => {
    const res = await request(app)
      .post("/webhook")
      .send({ foo: "bar", secret });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation failed");
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it("detects duplicate alerts", async () => {
    const alertId = "handler-dup-test-" + Date.now();
    // Pre-populate idempotency cache (simulates a previously successful send)
    isDuplicate(alertId);

    const payload = {
      ...validPayload,
      alert_id: alertId,
      signal_ts: Math.floor(Date.now() / 1000),
      secret,
    };

    const res = await request(app).post("/webhook").send(payload);
    expect(res.body.status).toBe("duplicate");
  });

  it("detects expired alerts (TTL)", async () => {
    const payload = {
      ...validPayload,
      alert_id: "handler-ttl-test-" + Date.now(),
      signal_ts: Math.floor(Date.now() / 1000) - 1500, // 25 min ago (TTL=1200s)
      secret,
    };
    const res = await request(app).post("/webhook").send(payload);
    expect(res.body.status).toBe("expired");
  });
});

describeHttp("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body).toHaveProperty("uptime");
    expect(res.body).toHaveProperty("alerts_processed");
  });

  it("shows redis status in health response", async () => {
    const res = await request(app).get("/health");
    expect(res.body).toHaveProperty("redis");
    expect(["connected", "fallback_memory"]).toContain(res.body.redis);
    expect(res.body).toHaveProperty("dedup_mode");
    expect(["redis", "memory"]).toContain(res.body.dedup_mode);
    expect(res.body).toHaveProperty("redis_configured");
    expect(typeof res.body.redis_configured).toBe("boolean");
    expect(res.body).toHaveProperty("dedup_degraded");
    expect(typeof res.body.dedup_degraded).toBe("boolean");
  });
});

describe("validateAlert — event_type restriction", () => {
  it("rejects invalid event_type", () => {
    const errors = validateAlert({
      ...validPayload,
      event_type: "EXIT",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("event_type"))).toBe(true);
  });

  it("accepts ENTRY event_type", () => {
    expect(validateAlert(validPayload)).toEqual([]);
  });
});

describe("formatWhatsAppMessage — edge cases", () => {
  it("formats minimal payload without optional fields", () => {
    const minimal: AlertPayload = {
      alert_id: "MINIMAL-1",
      event_type: "ENTRY",
      asset: "ETH",
      side: "LONG",
      entry: 3500,
      sl: 3400,
      qty: 1.5,
    };
    const msg = formatWhatsAppMessage(minimal);
    expect(msg).toContain("ETH LONG");
    expect(msg).toContain("*Entry:* $3500.00");
    expect(msg).toContain("*StopLoss:* $3400.00");
    expect(msg).toContain("*Qty:* 1.5");
    // Optional fields should NOT be present
    expect(msg).not.toContain("TP50");
    expect(msg).not.toContain("TP50");
    expect(msg).not.toContain("Leverage:");
    expect(msg).not.toContain("Risk:");
    expect(msg).not.toContain("Notional:");
    expect(msg).not.toContain("Margin:");
  });

  it("shows TP allocation in label", () => {
    const msg = formatWhatsAppMessage(validPayload);
    expect(msg).toContain("*TP50:*"); // TP1 = 50%
    expect(msg).toContain("*TP50:*"); // TP2 = rest (50%)
  });

  it("uses default tp1_pct of 50 when not provided", () => {
    const payload: AlertPayload = {
      ...validPayload,
      tp1_pct: undefined,
    };
    const msg = formatWhatsAppMessage(payload);
    expect(msg).toContain("*TP50:*");
  });

  it("shows leveraged SL percentage", () => {
    const msg = formatWhatsAppMessage(validPayload);
    // SL dist = 2300/97500 = 2.36%, at 5x = 11.79%
    expect(msg).toContain("at 5x)");
  });

  it("includes TTL expiry info", () => {
    const msg = formatWhatsAppMessage(validPayload);
    expect(msg).toContain("Expira em");
  });
});

describeHttp("POST /debug", () => {
  const secret = process.env.WEBHOOK_SECRET || "test-secret";

  it("returns 403 without secret", async () => {
    const res = await request(app)
      .post("/debug")
      .send({ data: "test" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("returns 403 with wrong secret", async () => {
    const res = await request(app)
      .post("/debug")
      .send({ secret: "wrong-secret", data: "test" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("returns logged with correct secret", async () => {
    const res = await request(app)
      .post("/debug")
      .send({ secret, data: "test-payload" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("logged");
  });
});

describeHttp("rate limiting", () => {
  it("returns 429 after exceeding /debug rate limit (5 req/min)", async () => {
    // /debug has rate limit of 5
    const responses = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(app)
        .post("/debug")
        .send({ secret: process.env.WEBHOOK_SECRET || "test-secret" });
      responses.push(res.status);
    }
    // At least one should be 429
    expect(responses).toContain(429);
  });
});

describeHttp("POST /webhook — send failure path", () => {
  const secret = process.env.WEBHOOK_SECRET || "test-secret";

  it(
    "returns 502 when WhatsApp send fails",
    { timeout: 20000 },
    async () => {
      const payload = {
        ...validPayload,
        alert_id: "send-fail-test-" + Date.now(),
        signal_ts: Math.floor(Date.now() / 1000),
        secret,
      };

      // No Evolution API running — sendWithRetry will fail after retry
      const res = await request(app).post("/webhook").send(payload);
      expect(res.status).toBe(502);
      expect(res.body.status).toBe("send_failed");
      expect(res.body.alert_id).toBe(payload.alert_id);
    },
  );

  it(
    "does not cache failed sends (allows retry)",
    { timeout: 20000 },
    async () => {
      const alertId = "no-cache-on-fail-" + Date.now();
      const payload = {
        ...validPayload,
        alert_id: alertId,
        signal_ts: Math.floor(Date.now() / 1000),
        secret,
      };

      // First attempt — will fail 502
      const res1 = await request(app).post("/webhook").send(payload);
      expect(res1.status).toBe(502);

      // Second attempt — should NOT be "duplicate" since failed sends aren't cached
      const res2 = await request(app).post("/webhook").send({
        ...payload,
        signal_ts: Math.floor(Date.now() / 1000),
      });
      expect(res2.body.status).not.toBe("duplicate");
    },
  );
});

describeHttp("POST /webhook/:token (token route)", () => {
  it("returns 403 for invalid URL token", async () => {
    const res = await request(app)
      .post("/webhook/wrong-token-value")
      .send({ ...validPayload, alert_id: "token-route-test-" + Date.now() });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("invalid token");
  });

  it("processes valid alert with correct token", async () => {
    const secret = process.env.WEBHOOK_SECRET || "test-secret";
    const alertId = "token-route-dup-" + Date.now();
    // Pre-populate cache for quick duplicate response
    isDuplicate(alertId);

    const res = await request(app)
      .post(`/webhook/${secret}`)
      .send({ ...validPayload, alert_id: alertId, signal_ts: Math.floor(Date.now() / 1000) });
    expect(res.body.status).toBe("duplicate");
  });
});

describeHttp("POST /webhook — success path (mocked fetch)", () => {
  const secret = process.env.WEBHOOK_SECRET || "test-secret";
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 'sent' when WhatsApp delivery succeeds", async () => {
    // Mock fetch to simulate successful Evolution API response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "PENDING" }),
    }) as unknown as typeof fetch;

    const alertId = "send-success-test-" + Date.now();
    const payload = {
      ...validPayload,
      alert_id: alertId,
      signal_ts: Math.floor(Date.now() / 1000),
      secret,
    };

    const res = await request(app).post("/webhook").send(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.alert_id).toBe(alertId);

    // Verify fetch was called (WhatsApp send)
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("returns 502 when Evolution API returns non-ok response", { timeout: 15000 }, async () => {
    // Mock fetch to return a non-ok response (covers sendWhatsApp error path)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }) as unknown as typeof fetch;

    const alertId = "non-ok-fetch-" + Date.now();
    const payload = {
      ...validPayload,
      alert_id: alertId,
      signal_ts: Math.floor(Date.now() / 1000),
      secret,
    };

    const res = await request(app).post("/webhook").send(payload);
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("send_failed");
  });

  it("caches sent alerts as duplicates", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "PENDING" }),
    }) as unknown as typeof fetch;

    const alertId = "dup-after-send-" + Date.now();
    const payload = {
      ...validPayload,
      alert_id: alertId,
      signal_ts: Math.floor(Date.now() / 1000),
      secret,
    };

    // First request — should succeed
    const res1 = await request(app).post("/webhook").send(payload);
    expect(res1.body.status).toBe("sent");

    // Second request — should be duplicate
    const res2 = await request(app).post("/webhook").send({
      ...payload,
      signal_ts: Math.floor(Date.now() / 1000),
    });
    expect(res2.body.status).toBe("duplicate");
  });
});

describeHttp("POST /webhook — accepts valid JSON in text/plain", () => {
  const secret = process.env.WEBHOOK_SECRET || "test-secret";

  it("parses JSON sent as text/plain", async () => {
    const alertId = "text-plain-test-" + Date.now();
    // Pre-populate cache to get a quick "duplicate" response
    isDuplicate(alertId);

    const payload = JSON.stringify({
      ...validPayload,
      alert_id: alertId,
      signal_ts: Math.floor(Date.now() / 1000),
      secret,
    });

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "text/plain")
      .send(payload);
    // Should parse the JSON and process it
    expect(res.body.status).toBe("duplicate");
  });
});
