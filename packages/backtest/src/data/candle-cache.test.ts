import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CandleCache } from "./candle-cache.js";
import type { Candle } from "../types/candle.js";

function makeCandle(t: number): Candle {
  return { t, o: 100, h: 110, l: 90, c: 105, v: 50, n: 20 };
}

describe("CandleCache", () => {
  let cache: CandleCache;

  beforeEach(() => {
    // Use in-memory SQLite for tests
    cache = new CandleCache(":memory:");
  });

  afterEach(() => {
    cache.close();
  });

  it("stores and retrieves candles", () => {
    const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
    cache.insertCandles("BTC", "15m", candles);

    const result = cache.getCandles("BTC", "15m", 0, 5000);
    expect(result).toHaveLength(3);
    expect(result[0].t).toBe(1000);
    expect(result[2].t).toBe(3000);
  });

  it("filters by time range", () => {
    const candles = [makeCandle(1000), makeCandle(2000), makeCandle(3000)];
    cache.insertCandles("BTC", "15m", candles);

    const result = cache.getCandles("BTC", "15m", 1500, 2500);
    expect(result).toHaveLength(1);
    expect(result[0].t).toBe(2000);
  });

  it("isolates by coin and interval", () => {
    cache.insertCandles("BTC", "15m", [makeCandle(1000)]);
    cache.insertCandles("ETH", "15m", [makeCandle(2000)]);
    cache.insertCandles("BTC", "1h", [makeCandle(3000)]);

    expect(cache.getCandles("BTC", "15m", 0, 5000)).toHaveLength(1);
    expect(cache.getCandles("ETH", "15m", 0, 5000)).toHaveLength(1);
    expect(cache.getCandles("BTC", "1h", 0, 5000)).toHaveLength(1);
    expect(cache.getCandles("SOL", "15m", 0, 5000)).toHaveLength(0);
  });

  it("upserts on duplicate timestamps", () => {
    cache.insertCandles("BTC", "15m", [{ ...makeCandle(1000), c: 100 }]);
    cache.insertCandles("BTC", "15m", [{ ...makeCandle(1000), c: 200 }]);

    const result = cache.getCandles("BTC", "15m", 0, 5000);
    expect(result).toHaveLength(1);
    expect(result[0].c).toBe(200); // Updated
  });

  it("tracks last timestamp in sync_meta", () => {
    expect(cache.getLastTimestamp("BTC", "15m")).toBeNull();

    cache.insertCandles("BTC", "15m", [makeCandle(1000), makeCandle(2000)]);
    expect(cache.getLastTimestamp("BTC", "15m")).toBe(2000);

    cache.insertCandles("BTC", "15m", [makeCandle(3000)]);
    expect(cache.getLastTimestamp("BTC", "15m")).toBe(3000);
  });

  it("counts candles correctly", () => {
    expect(cache.getCandleCount("BTC", "15m")).toBe(0);

    cache.insertCandles("BTC", "15m", [makeCandle(1000), makeCandle(2000)]);
    expect(cache.getCandleCount("BTC", "15m")).toBe(2);
  });

  it("returns candles sorted by timestamp", () => {
    cache.insertCandles("BTC", "15m", [makeCandle(3000), makeCandle(1000), makeCandle(2000)]);
    const result = cache.getCandles("BTC", "15m", 0, 5000);
    expect(result.map((c) => c.t)).toEqual([1000, 2000, 3000]);
  });

  it("sync fetches from API and caches", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { t: 1000, T: 1999, s: "BTC", i: "15m", o: "100", c: "105", h: "110", l: "90", v: "50", n: 20 },
        { t: 2000, T: 2999, s: "BTC", i: "15m", o: "105", c: "108", h: "112", l: "100", v: "30", n: 10 },
      ]),
    });
    globalThis.fetch = mockFetch;

    const result = await cache.sync("BTC", "15m", 0, 5000, { source: "hyperliquid", baseUrl: "http://test" });
    expect(result.fetched).toBe(2);
    expect(result.cached).toBe(2);
    expect(cache.getCandles("BTC", "15m", 0, 5000, "hyperliquid")).toHaveLength(2);

    globalThis.fetch = vi.fn();
  });

  it("sync skips when already up to date", async () => {
    cache.insertCandles("BTC", "15m", [makeCandle(5000)], "hyperliquid");

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    // startTime matches cached data, endTime within range → no fetch needed
    const result = await cache.sync("BTC", "15m", 5000, 5000, { source: "hyperliquid", baseUrl: "http://test" });
    expect(result.fetched).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();

    globalThis.fetch = vi.fn();
  });

  it("sync backfills earlier data", async () => {
    // Cache already has candle at t=5000
    cache.insertCandles("BTC", "15m", [makeCandle(5000)], "hyperliquid");

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { t: 1000, T: 1999, s: "BTC", i: "15m", o: "100", c: "105", h: "110", l: "90", v: "50", n: 20 },
        { t: 2000, T: 2999, s: "BTC", i: "15m", o: "105", c: "108", h: "112", l: "100", v: "30", n: 10 },
      ]),
    });
    globalThis.fetch = mockFetch;

    // Request data starting at t=0 → should backfill before t=5000
    const result = await cache.sync("BTC", "15m", 0, 5000, { source: "hyperliquid", baseUrl: "http://test" });
    expect(result.fetched).toBe(2);
    expect(result.cached).toBe(3); // 2 backfilled + 1 existing
    expect(cache.getCandles("BTC", "15m", 0, 6000, "hyperliquid")).toHaveLength(3);

    globalThis.fetch = vi.fn();
  });

  it("isolates data by source", () => {
    cache.insertCandles("BTC", "15m", [{ ...makeCandle(1000), c: 100 }], "bybit");
    cache.insertCandles("BTC", "15m", [{ ...makeCandle(1000), c: 200 }], "coinbase-perp");

    const bybit = cache.getCandles("BTC", "15m", 0, 5000, "bybit");
    const perp = cache.getCandles("BTC", "15m", 0, 5000, "coinbase-perp");

    expect(bybit).toHaveLength(1);
    expect(bybit[0].c).toBe(100);
    expect(perp).toHaveLength(1);
    expect(perp[0].c).toBe(200);
  });

  it("getFirstTimestamp returns earliest cached timestamp", () => {
    expect(cache.getFirstTimestamp("BTC", "15m")).toBeNull();
    cache.insertCandles("BTC", "15m", [makeCandle(3000), makeCandle(1000), makeCandle(2000)]);
    expect(cache.getFirstTimestamp("BTC", "15m")).toBe(1000);
  });
});
