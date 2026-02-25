import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockExists = vi.fn().mockResolvedValue(1);
const mockSetex = vi.fn().mockResolvedValue("OK");
const mockQuit = vi.fn().mockResolvedValue("OK");
const mockOn = vi.fn();
let mockStatus = "ready";

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => ({
    connect: mockConnect,
    exists: mockExists,
    setex: mockSetex,
    quit: mockQuit,
    on: mockOn,
    get status() { return mockStatus; },
  })),
}));

describe("redis (with mocked ioredis)", () => {
  let redis: typeof import("./redis.js");

  beforeEach(async () => {
    vi.resetModules();
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockExists.mockReset().mockResolvedValue(1);
    mockSetex.mockReset().mockResolvedValue("OK");
    mockQuit.mockReset().mockResolvedValue("OK");
    mockOn.mockReset();
    mockStatus = "ready";
    redis = await import("./redis.js");
  });

  afterEach(async () => {
    try { await redis.closeRedis(); } catch { /* ignore */ }
  });

  it("isRedisAvailable returns false before init", () => {
    expect(redis.isRedisAvailable()).toBe(false);
  });

  it("initRedis with no URL sets unavailable", async () => {
    const original = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const result = await redis.initRedis();
    expect(result).toEqual({
      configured: false,
      connected: false,
      dedupMode: "memory",
      reason: "not_configured",
    });
    expect(redis.isRedisAvailable()).toBe(false);
    if (original) process.env.REDIS_URL = original;
  });

  it("initRedis with URL connects and sets available", async () => {
    const result = await redis.initRedis("redis://localhost:6379");
    expect(result).toEqual({
      configured: true,
      connected: true,
      dedupMode: "redis",
      reason: "connected",
    });
    expect(mockConnect).toHaveBeenCalled();
    expect(redis.isRedisAvailable()).toBe(true);
  });

  it("initRedis sets unavailable when connect throws", async () => {
    mockConnect.mockRejectedValueOnce(new Error("connection refused"));
    const result = await redis.initRedis("redis://localhost:6379");
    expect(result).toEqual({
      configured: true,
      connected: false,
      dedupMode: "memory",
      reason: "connect_failed",
      error: "connection refused",
    });
    expect(redis.isRedisAvailable()).toBe(false);
  });

  it("getRedisRuntimeState reports configured+degraded when connect fails", async () => {
    mockConnect.mockRejectedValueOnce(new Error("down"));
    await redis.initRedis("redis://localhost:6379");
    expect(redis.getRedisRuntimeState()).toMatchObject({
      configured: true,
      connected: false,
      dedupMode: "memory",
      lastError: "down",
    });
  });

  it("error event handler sets available to false", async () => {
    await redis.initRedis("redis://localhost:6379");
    expect(redis.isRedisAvailable()).toBe(true);
    // Find the "error" handler
    const errorCall = mockOn.mock.calls.find((c) => c[0] === "error");
    expect(errorCall).toBeDefined();
    errorCall![1]();
    expect(redis.isRedisAvailable()).toBe(false);
  });

  it("redisHasDedup returns false when unavailable", async () => {
    expect(await redis.redisHasDedup("test-id")).toBe(false);
  });

  it("redisHasDedup returns true when key exists", async () => {
    await redis.initRedis("redis://localhost:6379");
    mockExists.mockResolvedValueOnce(1);
    expect(await redis.redisHasDedup("test-id")).toBe(true);
  });

  it("redisHasDedup returns false when key does not exist", async () => {
    await redis.initRedis("redis://localhost:6379");
    mockExists.mockResolvedValueOnce(0);
    expect(await redis.redisHasDedup("test-id")).toBe(false);
  });

  it("redisSetDedup returns false when unavailable", async () => {
    expect(await redis.redisSetDedup("test-id")).toBe(false);
  });

  it("redisSetDedup returns true on success", async () => {
    await redis.initRedis("redis://localhost:6379");
    expect(await redis.redisSetDedup("test-id")).toBe(true);
  });

  it("redisSetDedup returns false when setex throws", async () => {
    await redis.initRedis("redis://localhost:6379");
    mockSetex.mockRejectedValueOnce(new Error("write error"));
    expect(await redis.redisSetDedup("test-id")).toBe(false);
  });

  it("closeRedis calls quit and resets state", async () => {
    await redis.initRedis("redis://localhost:6379");
    expect(redis.isRedisAvailable()).toBe(true);
    await redis.closeRedis();
    expect(mockQuit).toHaveBeenCalled();
    expect(redis.isRedisAvailable()).toBe(false);
  });

  it("closeRedis is safe when no connection", async () => {
    await expect(redis.closeRedis()).resolves.not.toThrow();
  });
});
