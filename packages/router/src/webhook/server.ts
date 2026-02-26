import { env } from "../lib/env.js";
import express from "express";
import { timingSafeEqual, createHmac } from "node:crypto";
import rateLimit from "express-rate-limit";
import { LRUCache } from "lru-cache";
import got from "got";

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
import { logger, httpLogger } from "../lib/logger.js";
import { isMainModule, formatZodErrors } from "@breaker/kit";

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
    redis_configured: Boolean(env.REDIS_URL),
    dedup_degraded: dedupMode !== "redis",
  };
}

// ---------------------
// Idempotency cache (LRU with TTL)
// ---------------------
const sentAlerts = new LRUCache<string, true>({ max: 1000, ttl: 10 * 60 * 1000 });
let dedupRuntimeAlarmActive = false;

export function isDuplicate(alertId: string): boolean {
  if (sentAlerts.has(alertId)) return true;
  sentAlerts.set(alertId, true);
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

  const ttlMin = Math.round(env.TTL_SECONDS / 60);
  lines.push(`\u{23F1} _Expira em ${ttlMin}min_`);

  return lines.join("\n");
}

// ---------------------
// Send to WhatsApp Gateway
// ---------------------
async function sendWithRetry(text: string): Promise<unknown> {
  return got.post(`${env.GATEWAY_URL}/send`, {
    json: { text },
    timeout: { request: 10_000 },
    retry: { limit: 1, backoffLimit: 5000 },
  }).json();
}

// ---------------------
// Validation via Zod
// ---------------------
export function validateAlert(body: unknown): string[] {
  const result = AlertPayloadSchema.safeParse(body);
  if (result.success) return [];
  return formatZodErrors(result.error);
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
// Rate limiters (express-rate-limit)
// ---------------------
const webhookLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: false, legacyHeaders: false });
const healthLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: false, legacyHeaders: false });
const debugLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: false, legacyHeaders: false });

// ---------------------
// Express app
// ---------------------
export const app: express.Express = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.text({ type: "text/plain", limit: "100kb" }));
app.use(httpLogger);

app.get("/health", healthLimiter, (_req, res) => {
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
      logger.error({ raw: (req.body as string).slice(0, 500) }, "Invalid JSON in text body");
      res.status(400).json({ error: "invalid JSON" });
      return;
    }
  } else {
    alert = req.body;
  }

  const alertObj = alert as Record<string, unknown>;
  logger.info({ alert_id: alertObj.alert_id, asset: alertObj.asset, side: alertObj.side }, "Webhook received");

  const errors = validateAlert(alert);
  if (errors.length > 0) {
    logger.error({ alert_id: alertObj.alert_id, errors }, "Validation failed");
    res.status(400).json({ error: "validation failed", details: errors });
    return;
  }

  const typedAlert = alert as AlertPayload;

  if (typedAlert.signal_ts) {
    const ageSeconds = receiveTs / 1000 - typedAlert.signal_ts;
    if (ageSeconds > env.TTL_SECONDS) {
      logger.warn({ alert_id: typedAlert.alert_id, age_s: +ageSeconds.toFixed(1) }, "Alert expired (TTL)");
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
    logger.error({ alarm: "DEDUP_DEGRADED_RUNTIME", dedup_mode: "memory", last_error: redisState.lastError || "unknown" }, "ALARM: distributed dedup unavailable, fallback to memory");
  } else if (
    redisState.configured &&
    redisState.connected &&
    dedupRuntimeAlarmActive
  ) {
    dedupRuntimeAlarmActive = false;
    logger.info({ alarm: "DEDUP_RECOVERED", dedup_mode: "redis" }, "Redis dedup recovered");
  }

  const redisIsDup = await redisHasDedup(typedAlert.alert_id);
  if (redisIsDup) {
    logger.info({ alert_id: typedAlert.alert_id }, "Duplicate alert (redis), skipping");
    res.json({ status: "duplicate", alert_id: typedAlert.alert_id });
    return;
  }
  if (sentAlerts.has(typedAlert.alert_id)) {
    logger.info({ alert_id: typedAlert.alert_id }, "Duplicate alert (memory), skipping");
    res.json({ status: "duplicate", alert_id: typedAlert.alert_id });
    return;
  }

  try {
    const message = formatWhatsAppMessage(typedAlert);
    await sendWithRetry(message);
    await redisSetDedup(typedAlert.alert_id);
    isDuplicate(typedAlert.alert_id);
    logger.info({ alert_id: typedAlert.alert_id }, "WhatsApp sent");
    res.json({ status: "sent", alert_id: typedAlert.alert_id });
  } catch (err) {
    logger.error({ alert_id: typedAlert.alert_id, error: (err as Error).message }, "WhatsApp send failed after retry");
    res.status(502).json({
      status: "send_failed",
      alert_id: typedAlert.alert_id,
    });
  }
}

app.post("/webhook/:token", webhookLimiter, async (req, res) => {
  if (env.WEBHOOK_SECRET) {
    const token = req.params.token;
    if (!token || !safeCompare(token, env.WEBHOOK_SECRET)) {
      logger.warn({ path: req.path }, "Invalid URL token");
      res.status(403).json({ error: "invalid token" });
      return;
    }
  }
  await handleWebhook(req, res);
});

app.post("/webhook", webhookLimiter, async (req, res) => {
  if (env.WEBHOOK_SECRET) {
    let body: Record<string, unknown>;
    if (typeof req.body === "string") {
      try { body = JSON.parse(req.body); } catch { body = {}; }
    } else {
      body = req.body as Record<string, unknown>;
    }
    const provided = typeof body.secret === "string" ? body.secret : "";
    if (!provided || !safeCompare(provided, env.WEBHOOK_SECRET)) {
      logger.warn({ alert_id: body.alert_id }, "Invalid or missing secret");
      res.status(403).json({ error: "invalid secret" });
      return;
    }
  }
  await handleWebhook(req, res);
});

app.post("/debug", debugLimiter, (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (env.WEBHOOK_SECRET) {
    const provided = typeof body?.secret === "string" ? body.secret : "";
    if (!provided || !safeCompare(provided, env.WEBHOOK_SECRET)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
  }
  logger.debug({ body: body as unknown }, "Raw payload");
  res.json({ status: "logged" });
});

if (isMainModule(import.meta.url)) {
  const bootstrap = async (): Promise<void> => {
    if (!env.GATEWAY_URL || env.GATEWAY_URL === "http://localhost:3100") {
      logger.warn("GATEWAY_URL not set — using default localhost:3100");
    }
    if (!env.WEBHOOK_SECRET) {
      logger.warn("WEBHOOK_SECRET not set — webhook accepts unauthenticated requests");
    }

    const redisInit = await initRedis();
    const redisPolicy = getRedisStartupPolicy(redisInit);

    if (redisPolicy === "fail_fast") {
      logger.error({ alarm: "REDIS_REQUIRED_UNAVAILABLE", dedup_mode: "memory", reason: redisInit.reason, error: redisInit.error || "unknown" }, "ALARM: Redis configured but unavailable; refusing startup");
      process.exit(1);
      return;
    }

    if (redisPolicy === "degraded") {
      logger.warn({ alarm: "DEDUP_DEGRADED_STARTUP", dedup_mode: "memory" }, "ALARM: Redis not configured; dedup is memory-only");
    } else {
      logger.info({ dedup_mode: "redis" }, "Redis connected; distributed dedup enabled");
    }

    app.listen(env.PORT, () => {
      logger.info({ ttl: env.TTL_SECONDS, gateway_url: env.GATEWAY_URL, dedup_mode: getDedupHealthState().dedup_mode }, `Webhook server started on port ${env.PORT}`);
    });
  };

  bootstrap().catch((err: unknown) => {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Webhook startup failed");
    process.exit(1);
  });
}
