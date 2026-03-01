import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Exchange } from "ccxt";
import { CandleCache } from "./candle-cache.js";
import type { Candle } from "../types/candle.js";

function makeCandle(t: number): Candle {
  return { t, o: 100, h: 110, l: 90, c: 105, v: 50, n: 20 };
}

function makeMockExchange(ohlcvData: [number, number, number, number, number, number][][]): Exchange {
  const fetchOHLCV = vi.fn();
  for (const batch of ohlcvData) {
    fetchOHLCV.mockResolvedValueOnce(batch);
  }
  return { fetchOHLCV } as unknown as Exchange;
}

describe("CandleCache", () => {
  let cache: CandleCache;

  beforeEach(() => {
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
    expect(result[0].c).toBe(200);
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
    const exchange = makeMockExchange([
      [[1000, 100, 110, 90, 105, 50], [2000, 105, 112, 100, 108, 30]],
    ]);

    const result = await cache.sync("BTC", "15m", 0, 5000, {
      source: "hyperliquid",
      _exchange: exchange,
    });
    expect(result.fetched).toBe(2);
    expect(result.cached).toBe(2);
    expect(cache.getCandles("BTC", "15m", 0, 5000, "hyperliquid")).toHaveLength(2);
  });

  it("sync skips when already up to date", async () => {
    cache.insertCandles("BTC", "15m", [makeCandle(5000)], "hyperliquid");

    const exchange = makeMockExchange([]);
    const result = await cache.sync("BTC", "15m", 5000, 5000, {
      source: "hyperliquid",
      _exchange: exchange,
    });
    expect(result.fetched).toBe(0);
    expect(exchange.fetchOHLCV).not.toHaveBeenCalled();
  });

  it("sync backfills earlier data", async () => {
    cache.insertCandles("BTC", "15m", [makeCandle(5000)], "hyperliquid");

    const exchange = makeMockExchange([
      [[1000, 100, 110, 90, 105, 50], [2000, 105, 112, 100, 108, 30]],
    ]);

    const result = await cache.sync("BTC", "15m", 0, 5000, {
      source: "hyperliquid",
      _exchange: exchange,
    });
    expect(result.fetched).toBe(2);
    expect(result.cached).toBe(3);
    expect(cache.getCandles("BTC", "15m", 0, 6000, "hyperliquid")).toHaveLength(3);
  });

  it("sync re-fetches last candle to overwrite in-progress data", async () => {
    // Simulate an in-progress candle saved with partial OHLCV
    const inProgressCandle: Candle = { t: 5000, o: 100, h: 105, l: 99, c: 102, v: 10, n: 5 };
    cache.insertCandles("BTC", "15m", [makeCandle(1000), inProgressCandle], "hyperliquid");
    expect(cache.getLastTimestamp("BTC", "15m", "hyperliquid")).toBe(5000);

    // On next sync, the API returns the finalized candle with updated OHLCV
    const finalizedCandle = [5000, 100, 112, 95, 108, 50] as [number, number, number, number, number, number];
    const exchange = makeMockExchange([[finalizedCandle, [6000, 108, 115, 106, 113, 40]]]);

    await cache.sync("BTC", "15m", 1000, 7000, { source: "hyperliquid", _exchange: exchange });

    // The in-progress candle should be overwritten with final values
    const candles = cache.getCandles("BTC", "15m", 4000, 7000, "hyperliquid");
    const updated = candles.find((c) => c.t === 5000);
    expect(updated).toBeDefined();
    expect(updated!.h).toBe(112);
    expect(updated!.l).toBe(95);
    expect(updated!.c).toBe(108);
    expect(updated!.v).toBe(50);

    // The new candle at 6000 should also be present
    expect(candles.find((c) => c.t === 6000)).toBeDefined();
  });

  it("isolates data by source", () => {
    cache.insertCandles("BTC", "15m", [{ ...makeCandle(1000), c: 100 }], "binance");
    cache.insertCandles("BTC", "15m", [{ ...makeCandle(1000), c: 200 }], "hyperliquid");

    const binance = cache.getCandles("BTC", "15m", 0, 5000, "binance");
    const hl = cache.getCandles("BTC", "15m", 0, 5000, "hyperliquid");

    expect(binance).toHaveLength(1);
    expect(binance[0].c).toBe(100);
    expect(hl).toHaveLength(1);
    expect(hl[0].c).toBe(200);
  });

  it("getFirstTimestamp returns earliest cached timestamp", () => {
    expect(cache.getFirstTimestamp("BTC", "15m")).toBeNull();
    cache.insertCandles("BTC", "15m", [makeCandle(3000), makeCandle(1000), makeCandle(2000)]);
    expect(cache.getFirstTimestamp("BTC", "15m")).toBe(1000);
  });
});
