import { Redis } from "ioredis";

let redis: Redis | null = null;
let available = false;
let configured = false;
let lastError: string | null = null;

const DEDUP_TTL = 600; // 10 minutes

export type RedisDedupMode = "redis" | "memory";

export type RedisInitResult = {
  configured: boolean;
  connected: boolean;
  dedupMode: RedisDedupMode;
  reason: "not_configured" | "connected" | "connect_failed";
  error?: string;
};

export async function initRedis(url?: string): Promise<RedisInitResult> {
  const redisUrl = url || process.env.REDIS_URL;
  configured = Boolean(redisUrl);
  lastError = null;

  if (redis) {
    try {
      await redis.quit();
    } catch {
      // ignore and recreate client below
    }
    redis = null;
    available = false;
  }

  if (!redisUrl) {
    available = false;
    return {
      configured: false,
      connected: false,
      dedupMode: "memory",
      reason: "not_configured",
    };
  }

  try {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 3000,
    });

    redis.on("error", (err: unknown) => {
      available = false;
      lastError = err instanceof Error ? err.message : "redis_error";
    });

    redis.on("ready", () => {
      available = true;
      lastError = null;
    });

    await redis.connect();
    available = true;
    return {
      configured: true,
      connected: true,
      dedupMode: "redis",
      reason: "connected",
    };
  } catch (err) {
    available = false;
    redis = null;
    const message = err instanceof Error ? err.message : "connect_failed";
    lastError = message;
    return {
      configured: true,
      connected: false,
      dedupMode: "memory",
      reason: "connect_failed",
      error: message,
    };
  }
}

export function isRedisAvailable(): boolean {
  return available && redis !== null && redis.status === "ready";
}

export function getRedisRuntimeState(): {
  configured: boolean;
  connected: boolean;
  dedupMode: RedisDedupMode;
  lastError?: string;
} {
  const connected = isRedisAvailable();
  return {
    configured,
    connected,
    dedupMode: connected ? "redis" : "memory",
    ...(lastError ? { lastError } : {}),
  };
}

export async function redisHasDedup(alertId: string): Promise<boolean> {
  if (!isRedisAvailable() || !redis) return false;
  try {
    const result = await redis.exists(`alert:dedup:${alertId}`);
    return result === 1;
  } catch {
    available = false;
    return false;
  }
}

export async function redisSetDedup(alertId: string): Promise<boolean> {
  if (!isRedisAvailable() || !redis) return false;
  try {
    await redis.setex(`alert:dedup:${alertId}`, DEDUP_TTL, "1");
    return true;
  } catch {
    available = false;
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    try {
      await redis.quit();
    } catch {
      // ignore
    }
    redis = null;
  }
  available = false;
  configured = false;
  lastError = null;
}
