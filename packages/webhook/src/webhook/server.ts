import express from "express";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, createHmac } from "node:crypto";

import { AlertPayloadSchema } from "../types/alert.js";
import type { AlertPayload } from "../types/alert.js";
import {
  initRedis,
  isRedisAvailable,
  redisHasDedup,
  redisSetDedup,
  getRedisRuntimeState,
} from "../lib/redis.js";
import type { RedisInitResult } from "../lib/redis.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------
// Config (from .env or defaults)
// ---------------------
function loadEnv(): void {
  try {
    const envPath = join(__dirname, "../../infra/.env");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env missing is fine
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || "3000");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3100";
const TTL_SECONDS = parseInt(process.env.TTL_SECONDS || "1200");
const REDIS_REQUIRED = Boolean(process.env.REDIS_URL);

export type RedisStartupPolicy = "ready" | "degraded" | "fail_fast";

export function getRedisStartupPolicy(result: RedisInitResult): RedisStartupPolicy {
  if (result.configured && !result.connected) return "fail_fast";
  if (!result.connected) return "degraded";
  return "ready";
}

function getDedupHealthState(): {
  redis: "connected" | "fallback_memory";
  dedup_mode: "redis" | "memory";
  redis_configured: boolean;
  dedup_degraded: boolean;
} {
  const redisConnected = isRedisAvailable();
  const dedupMode = redisConnected ? "redis" : "memory";
  return {
    redis: redisConnected ? "connected" : "fallback_memory",
    dedup_mode: dedupMode,
    redis_configured: REDIS_REQUIRED,
    dedup_degraded: dedupMode !== "redis",
  };
}

// ---------------------
// Logging
// ---------------------
const LOG_DIR = process.env.LOG_DIR || join(__dirname, "../../infra/logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function log(
  level: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  const ts = new Date().toISOString();
  const entry = JSON.stringify({ ts, level, msg, ...data });
  console.log(entry);
  const dateStr = ts.slice(0, 10);
  appendFileSync(join(LOG_DIR, `${dateStr}.ndjson`), entry + "\n");
}

// ---------------------
// Idempotency cache (in-memory, TTL + size cap)
// ---------------------
const sentAlerts = new Map<string, number>();
const MAX_CACHE = 1000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let dedupRuntimeAlarmActive = false;

export function isDuplicate(alertId: string): boolean {
  const now = Date.now();
  if (sentAlerts.size > MAX_CACHE / 2) {
    for (const [key, ts] of sentAlerts) {
      if (now - ts > CACHE_TTL_MS) sentAlerts.delete(key);
    }
  }
  if (sentAlerts.has(alertId)) {
    const ts = sentAlerts.get(alertId)!;
    if (now - ts > CACHE_TTL_MS) {
      sentAlerts.delete(alertId);
    } else {
      return true;
    }
  }
  sentAlerts.set(alertId, now);
  if (sentAlerts.size > MAX_CACHE) {
    const first = sentAlerts.keys().next().value;
    if (first !== undefined) sentAlerts.delete(first);
  }
  return false;
}

// ---------------------
// WhatsApp message formatter
// ---------------------
export function formatWhatsAppMessage(alert: AlertPayload): string {
  const side = alert.side === "LONG" ? "LONG" : "SHORT";
  const icon = alert.side === "LONG" ? "\u{1F7E2}" : "\u{1F534}";
  const slPctVal = (Math.abs(alert.sl - alert.entry) / alert.entry) * 100;
  const slDir = alert.side === "LONG" ? "-" : "+";
  const tpDir = alert.side === "LONG" ? "+" : "-";
  const lev = alert.leverage ?? 1;
  const slLev = (slPctVal * lev).toFixed(2);

  const lines: string[] = [];

  lines.push(`${icon} *${alert.asset} ${side}*`);
  lines.push("");

  lines.push(`\u{1F4CD} *Entry:* $${alert.entry.toFixed(2)}`);
  lines.push(`\u{1F6D1} *StopLoss:* $${alert.sl.toFixed(2)} (${slDir}${slPctVal.toFixed(2)}%)(${slLev}% at ${lev}x)`);
  const tp1Alloc = alert.tp1_pct ?? 50;
  const tp2Alloc = 100 - tp1Alloc;
  if (alert.tp1) {
    const tp1PctVal = (Math.abs(alert.tp1 - alert.entry) / alert.entry) * 100;
    const tp1Lev = (tp1PctVal * lev).toFixed(2);
    lines.push(`\u{1F3AF} *TP${tp1Alloc}:* $${alert.tp1.toFixed(2)} (${tpDir}${tp1PctVal.toFixed(2)}%)(${tp1Lev}% at ${lev}x)`);
  }
  if (alert.tp2) {
    const tp2PctVal = (Math.abs(alert.tp2 - alert.entry) / alert.entry) * 100;
    const tp2Lev = (tp2PctVal * lev).toFixed(2);
    lines.push(`\u{1F3AF} *TP${tp2Alloc}:* $${alert.tp2.toFixed(2)} (${tpDir}${tp2PctVal.toFixed(2)}%)(${tp2Lev}% at ${lev}x)`);
  }
  lines.push("");

  lines.push(`\u{1F4CA} *Qty:* ${alert.qty}`);
  if (alert.risk_usd) lines.push(`\u{26A0}\u{FE0F} *Risk:* $${alert.risk_usd.toFixed(2)}`);
  if (alert.leverage) lines.push(`\u{26A1} *Leverage:* ${alert.leverage}x`);
  if (alert.notional_usdc) lines.push(`\u{1F4B0} *Notional:* $${alert.notional_usdc.toFixed(2)}`);
  if (alert.margin_usdc) lines.push(`\u{1F4B3} *Margin:* $${alert.margin_usdc.toFixed(2)}`);
  lines.push("");

  const ttlMin = Math.round(TTL_SECONDS / 60);
  lines.push(`\u{23F1} _Expira em ${ttlMin}min_`);

  return lines.join("\n");
}

// ---------------------
// Send to WhatsApp Gateway
// ---------------------
async function sendToGateway(text: string): Promise<unknown> {
  const res = await fetch(`${GATEWAY_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gateway ${res.status}: ${errText}`);
  }

  return await res.json();
}

async function sendWithRetry(text: string): Promise<unknown> {
  try {
    return await sendToGateway(text);
  } catch (err) {
    log("warn", "Gateway send failed, retrying in 5s", {
      error: (err as Error).message,
    });
    await new Promise((r) => setTimeout(r, 5000));
    return await sendToGateway(text);
  }
}

// ---------------------
// Validation via Zod
// ---------------------
export function validateAlert(body: unknown): string[] {
  const result = AlertPayloadSchema.safeParse(body);
  if (result.success) return [];
  return result.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`,
  );
}

// ---------------------
// Constant-time secret comparison
// ---------------------
function safeCompare(a: string, b: string): boolean {
  const hmac = (val: string) =>
    createHmac("sha256", "cmp").update(val).digest();
  return timingSafeEqual(hmac(a), hmac(b));
}

// ---------------------
// Rate limiter — in-memory, per-IP
// ---------------------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL = 5 * 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (val.resetAt <= now) rateLimitMap.delete(key);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL).unref();

function rateLimit(maxRequests: number): express.RequestHandler {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const basePath = req.route?.path ?? (req.path.replace(/\/[^/]+$/, "") || req.path);
    const key = `${ip}:${basePath}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || entry.resetAt <= now) {
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      next();
      return;
    }

    entry.count++;
    if (entry.count > maxRequests) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    next();
  };
}

// ---------------------
// Express app
// ---------------------
export const app: express.Express = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.text({ type: "text/plain", limit: "100kb" }));

app.get("/health", rateLimit(60), (_req, res) => {
  const dedup = getDedupHealthState();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    alerts_processed: sentAlerts.size,
    redis: dedup.redis,
    dedup_mode: dedup.dedup_mode,
    redis_configured: dedup.redis_configured,
    dedup_degraded: dedup.dedup_degraded,
  });
});

async function handleWebhook(req: express.Request, res: express.Response): Promise<void> {
  const receiveTs = Date.now();

  let alert: unknown;
  if (typeof req.body === "string") {
    try {
      alert = JSON.parse(req.body);
    } catch {
      log("error", "Invalid JSON in text body", {
        raw: (req.body as string).slice(0, 500),
      });
      res.status(400).json({ error: "invalid JSON" });
      return;
    }
  } else {
    alert = req.body;
  }

  const alertObj = alert as Record<string, unknown>;
  log("info", "Webhook received", {
    alert_id: alertObj.alert_id,
    asset: alertObj.asset,
    side: alertObj.side,
  });

  const errors = validateAlert(alert);
  if (errors.length > 0) {
    log("error", "Validation failed", {
      alert_id: alertObj.alert_id,
      errors,
    });
    res.status(400).json({ error: "validation failed", details: errors });
    return;
  }

  const typedAlert = alert as AlertPayload;

  if (typedAlert.signal_ts) {
    const ageSeconds = receiveTs / 1000 - typedAlert.signal_ts;
    if (ageSeconds > TTL_SECONDS) {
      log("warn", "Alert expired (TTL)", {
        alert_id: typedAlert.alert_id,
        age_s: +ageSeconds.toFixed(1),
      });
      res.json({
        status: "expired",
        alert_id: typedAlert.alert_id,
        age_s: ageSeconds,
      });
      return;
    }
  }

  const redisState = getRedisRuntimeState();
  if (redisState.configured && !redisState.connected && !dedupRuntimeAlarmActive) {
    dedupRuntimeAlarmActive = true;
    log("error", "ALARM: distributed dedup unavailable, fallback to memory", {
      alarm: "DEDUP_DEGRADED_RUNTIME",
      dedup_mode: "memory",
      last_error: redisState.lastError || "unknown",
    });
  } else if (
    redisState.configured &&
    redisState.connected &&
    dedupRuntimeAlarmActive
  ) {
    dedupRuntimeAlarmActive = false;
    log("info", "Redis dedup recovered", {
      alarm: "DEDUP_RECOVERED",
      dedup_mode: "redis",
    });
  }

  const redisIsDup = await redisHasDedup(typedAlert.alert_id);
  if (redisIsDup) {
    log("info", "Duplicate alert (redis), skipping", {
      alert_id: typedAlert.alert_id,
    });
    res.json({ status: "duplicate", alert_id: typedAlert.alert_id });
    return;
  }
  if (sentAlerts.has(typedAlert.alert_id)) {
    const ts = sentAlerts.get(typedAlert.alert_id)!;
    if (Date.now() - ts <= CACHE_TTL_MS) {
      log("info", "Duplicate alert (memory), skipping", {
        alert_id: typedAlert.alert_id,
      });
      res.json({
        status: "duplicate",
        alert_id: typedAlert.alert_id,
      });
      return;
    }
    sentAlerts.delete(typedAlert.alert_id);
  }

  try {
    const message = formatWhatsAppMessage(typedAlert);
    await sendWithRetry(message);
    await redisSetDedup(typedAlert.alert_id);
    isDuplicate(typedAlert.alert_id);
    log("info", "WhatsApp sent", { alert_id: typedAlert.alert_id });
    res.json({ status: "sent", alert_id: typedAlert.alert_id });
  } catch (err) {
    log("error", "WhatsApp send failed after retry", {
      alert_id: typedAlert.alert_id,
      error: (err as Error).message,
    });
    res.status(502).json({
      status: "send_failed",
      alert_id: typedAlert.alert_id,
    });
  }
}

app.post("/webhook/:token", rateLimit(30), async (req, res) => {
  if (WEBHOOK_SECRET) {
    const token = req.params.token;
    if (!token || !safeCompare(token, WEBHOOK_SECRET)) {
      log("warn", "Invalid URL token", { path: req.path });
      res.status(403).json({ error: "invalid token" });
      return;
    }
  }
  await handleWebhook(req, res);
});

app.post("/webhook", rateLimit(30), async (req, res) => {
  if (WEBHOOK_SECRET) {
    let body: Record<string, unknown>;
    if (typeof req.body === "string") {
      try { body = JSON.parse(req.body); } catch { body = {}; }
    } else {
      body = req.body as Record<string, unknown>;
    }
    const provided = typeof body.secret === "string" ? body.secret : "";
    if (!provided || !safeCompare(provided, WEBHOOK_SECRET)) {
      log("warn", "Invalid or missing secret", { alert_id: body.alert_id });
      res.status(403).json({ error: "invalid secret" });
      return;
    }
  }
  await handleWebhook(req, res);
});

app.post("/debug", rateLimit(5), (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (WEBHOOK_SECRET) {
    const provided = typeof body?.secret === "string" ? body.secret : "";
    if (!provided || !safeCompare(provided, WEBHOOK_SECRET)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
  }
  log("debug", "Raw payload", { body: body as unknown });
  res.json({ status: "logged" });
});

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.js");

if (isMain) {
  const bootstrap = async (): Promise<void> => {
    if (!GATEWAY_URL || GATEWAY_URL === "http://localhost:3100") {
      console.error(
        "WARNING: GATEWAY_URL not set — using default localhost:3100",
      );
    }
    if (!WEBHOOK_SECRET) {
      console.error(
        "WARNING: WEBHOOK_SECRET not set — webhook accepts unauthenticated requests",
      );
    }

    const redisInit = await initRedis();
    const redisPolicy = getRedisStartupPolicy(redisInit);

    if (redisPolicy === "fail_fast") {
      log("error", "ALARM: Redis configured but unavailable; refusing startup", {
        alarm: "REDIS_REQUIRED_UNAVAILABLE",
        dedup_mode: "memory",
        reason: redisInit.reason,
        error: redisInit.error || "unknown",
      });
      process.exit(1);
      return;
    }

    if (redisPolicy === "degraded") {
      log("warn", "ALARM: Redis not configured; dedup is memory-only", {
        alarm: "DEDUP_DEGRADED_STARTUP",
        dedup_mode: "memory",
      });
    } else {
      log("info", "Redis connected; distributed dedup enabled", {
        dedup_mode: "redis",
      });
    }

    app.listen(PORT, () => {
      log("info", `Webhook server started on port ${PORT}`, {
        ttl: TTL_SECONDS,
        gateway_url: GATEWAY_URL,
        dedup_mode: getDedupHealthState().dedup_mode,
      });
    });
  };

  bootstrap().catch((err: unknown) => {
    log("error", "Webhook startup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
