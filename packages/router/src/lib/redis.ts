import { Redis } from "ioredis";

let redisClient: Redis | null = null;
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

function isAvailable(): boolean {
  return available && redisClient !== null && redisClient.status === "ready";
}

export const redis = {
  async init(url?: string): Promise<RedisInitResult> {
    const redisUrl = url || process.env.REDIS_URL;
    configured = Boolean(redisUrl);
    lastError = null;

    if (redisClient) {
      try {
        await redisClient.quit();
      } catch {
        // ignore and recreate client below
      }
      redisClient = null;
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
      redisClient = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 3000,
      });

      redisClient.on("error", (err: unknown) => {
        available = false;
        lastError = err instanceof Error ? err.message : "redis_error";
      });

      redisClient.on("ready", () => {
        available = true;
        lastError = null;
      });

      await redisClient.connect();
      available = true;
      return {
        configured: true,
        connected: true,
        dedupMode: "redis",
        reason: "connected",
      };
    } catch (err) {
      available = false;
      redisClient = null;
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
  },

  isAvailable,

  getRuntimeState(): {
    configured: boolean;
    connected: boolean;
    dedupMode: RedisDedupMode;
    lastError?: string;
  } {
    const connected = isAvailable();
    return {
      configured,
      connected,
      dedupMode: connected ? "redis" : "memory",
      ...(lastError ? { lastError } : {}),
    };
  },

  async hasDedup(alertId: string): Promise<boolean> {
    if (!isAvailable() || !redisClient) return false;
    try {
      const result = await redisClient.exists(`alert:dedup:${alertId}`);
      return result === 1;
    } catch {
      available = false;
      return false;
    }
  },

  async setDedup(alertId: string): Promise<boolean> {
    if (!isAvailable() || !redisClient) return false;
    try {
      await redisClient.setex(`alert:dedup:${alertId}`, DEDUP_TTL, "1");
      return true;
    } catch {
      available = false;
      return false;
    }
  },
};
