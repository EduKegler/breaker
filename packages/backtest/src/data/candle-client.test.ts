import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Exchange } from "ccxt";
import { fetchCandles } from "./fetch-candles.js";
import { toSymbol, type DataSource } from "./to-symbol.js";

/** Create a mock CCXT exchange with a spied fetchOHLCV. */
function makeMockExchange(): Exchange {
  return { fetchOHLCV: vi.fn() } as unknown as Exchange;
}

/** Helper: build an OHLCV row [t, o, h, l, c, v]. */
function ohlcv(t: number, o = 100, h = 110, l = 90, c = 105, v = 50): [number, number, number, number, number, number] {
  return [t, o, h, l, c, v];
}

describe("toSymbol", () => {
  it("maps binance → BTC/USDT:USDT", () => {
    expect(toSymbol("BTC", "binance")).toBe("BTC/USDT:USDT");
  });

  it("maps hyperliquid → BTC/USDC:USDC", () => {
    expect(toSymbol("BTC", "hyperliquid")).toBe("BTC/USDC:USDC");
  });

  it("works with other coins", () => {
    expect(toSymbol("ETH", "binance")).toBe("ETH/USDT:USDT");
    expect(toSymbol("SOL", "hyperliquid")).toBe("SOL/USDC:USDC");
  });
});

describe("fetchCandles", () => {
  let exchange: Exchange;

  beforeEach(() => {
    exchange = makeMockExchange();
  });

  it("fetches and parses OHLCV into Candle[]", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([
      ohlcv(1000, 100, 110, 95, 105, 50),
      ohlcv(2000, 105, 112, 103, 108, 30),
    ]);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "binance",
      _exchange: exchange,
    });

    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ t: 1000, o: 100, h: 110, l: 95, c: 105, v: 50, n: 0 });
    expect(candles[1]).toEqual({ t: 2000, o: 105, h: 112, l: 103, c: 108, v: 30, n: 0 });
  });

  it("sets n: 0 for all sources", async () => {
    for (const source of ["binance", "hyperliquid"] as DataSource[]) {
      const ex = makeMockExchange();
      vi.mocked(ex.fetchOHLCV).mockResolvedValueOnce([ohlcv(1000)]);

      const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
        source,
        _exchange: ex,
      });
      expect(candles[0].n).toBe(0);
    }
  });

  it("defaults to binance source", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([]);

    await fetchCandles("BTC", "15m", 1000, 5000, { _exchange: exchange });

    expect(exchange.fetchOHLCV).toHaveBeenCalledWith(
      "BTC/USDT:USDT",
      "15m",
      1000,
      1500, // binance default limit
    );
  });

  it("uses correct symbol per source", async () => {
    const sources: [DataSource, string][] = [
      ["binance", "BTC/USDT:USDT"],
      ["hyperliquid", "BTC/USDC:USDC"],
    ];

    for (const [source, expectedSymbol] of sources) {
      const ex = makeMockExchange();
      vi.mocked(ex.fetchOHLCV).mockResolvedValueOnce([]);

      await fetchCandles("BTC", "15m", 1000, 5000, { source, _exchange: ex });

      expect(ex.fetchOHLCV).toHaveBeenCalledWith(
        expectedSymbol,
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
      );
    }
  });

  it("allows ccxtSymbol override", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([]);

    await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "binance",
      ccxtSymbol: "BTC/USDC:USDC",
      _exchange: exchange,
    });

    expect(exchange.fetchOHLCV).toHaveBeenCalledWith(
      "BTC/USDC:USDC",
      "15m",
      1000,
      1500,
    );
  });

  it("paginates across multiple batches until empty response", async () => {
    const batch1 = Array.from({ length: 500 }, (_, i) => ohlcv(1000 + i * 900_000));
    const batch2 = [ohlcv(1000 + 500 * 900_000)];

    vi.mocked(exchange.fetchOHLCV)
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);

    const candles = await fetchCandles("BTC", "15m", 1000, Number.MAX_SAFE_INTEGER, {
      source: "hyperliquid",
      candlesPerRequest: 500,
      requestDelayMs: 0,
      _exchange: exchange,
    });

    expect(candles).toHaveLength(501);
    expect(exchange.fetchOHLCV).toHaveBeenCalledTimes(3);
  });

  it("continues paginating after partial batch when endTime not reached", async () => {
    const endTime = 1000 + 10 * 900_000;
    const batch1 = [ohlcv(1000), ohlcv(1000 + 900_000)]; // 2 < limit 500
    const batch2 = [ohlcv(1000 + 2 * 900_000)];

    vi.mocked(exchange.fetchOHLCV)
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);

    const candles = await fetchCandles("BTC", "15m", 1000, endTime, {
      source: "hyperliquid",
      candlesPerRequest: 500,
      requestDelayMs: 0,
      _exchange: exchange,
    });

    expect(candles).toHaveLength(3);
    expect(exchange.fetchOHLCV).toHaveBeenCalledTimes(3);
  });

  it("stops paginating when since passes endTime", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([
      ohlcv(1000),
      ohlcv(2000),
    ]);

    const candles = await fetchCandles("BTC", "15m", 1000, 100000, {
      source: "binance",
      candlesPerRequest: 1500,
      _exchange: exchange,
    });

    expect(candles).toHaveLength(2);
    expect(exchange.fetchOHLCV).toHaveBeenCalledTimes(1);
  });

  it("stops when exchange returns empty array", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([]);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      _exchange: exchange,
    });

    expect(candles).toHaveLength(0);
  });

  it("deduplicates candles by timestamp", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([
      ohlcv(1000),
      ohlcv(1000),
      ohlcv(2000),
    ]);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      _exchange: exchange,
    });

    expect(candles).toHaveLength(2);
  });

  it("filters candles beyond endTime", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([
      ohlcv(1000),
      ohlcv(2000),
      ohlcv(6000), // beyond endTime=5000
    ]);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      _exchange: exchange,
    });

    expect(candles).toHaveLength(2);
  });

  it("avoids infinite loop when lastTs < since", async () => {
    // Exchange keeps returning a stale timestamp behind since
    vi.mocked(exchange.fetchOHLCV)
      .mockResolvedValueOnce([ohlcv(1000)])
      .mockResolvedValueOnce([ohlcv(500)]); // behind since (1000 + 900_000)

    const candles = await fetchCandles("BTC", "15m", 1000, Number.MAX_SAFE_INTEGER, {
      source: "binance",
      candlesPerRequest: 1,
      requestDelayMs: 0,
      _exchange: exchange,
    });

    // Both candles collected, but stale lastTs stops pagination
    expect(candles).toHaveLength(2);
    expect(exchange.fetchOHLCV).toHaveBeenCalledTimes(2);
  });

  it("propagates exchange errors", async () => {
    vi.mocked(exchange.fetchOHLCV).mockRejectedValueOnce(
      new Error("NetworkError: connection failed"),
    );

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { _exchange: exchange }),
    ).rejects.toThrow("NetworkError: connection failed");
  });

  it("returns candles sorted oldest-first", async () => {
    vi.mocked(exchange.fetchOHLCV).mockResolvedValueOnce([
      ohlcv(3000),
      ohlcv(1000),
      ohlcv(2000),
    ]);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      _exchange: exchange,
    });

    expect(candles.map((c) => c.t)).toEqual([1000, 2000, 3000]);
  });
});
