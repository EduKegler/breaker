import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGot } = vi.hoisted(() => {
  const mockGot = vi.fn();
  return { mockGot };
});

vi.mock("got", async (importOriginal) => {
  const actual = await importOriginal<typeof import("got")>();
  return {
    ...actual,
    default: mockGot,
  };
});

import { HTTPError } from "got";
import { fetchCandles } from "./candle-client.js";

/** Helper: make got resolve with a JSON body. */
function mockGotJson(body: unknown) {
  return mockGot.mockReturnValueOnce({ json: () => Promise.resolve(body) } as never);
}

/** Helper: create a fake HTTPError with the given status code. */
function makeHttpError(statusCode: number, statusMessage: string): HTTPError {
  const err = Object.create(HTTPError.prototype) as HTTPError;
  Object.defineProperty(err, "response", {
    value: { statusCode, statusMessage, body: "" },
    writable: false,
  });
  Object.defineProperty(err, "message", {
    value: `Response code ${statusCode} (${statusMessage})`,
    writable: true,
  });
  return err;
}

/** Helper: make got reject with an HTTPError. */
function mockGotHttpError(statusCode: number, statusMessage: string) {
  const err = makeHttpError(statusCode, statusMessage);
  return mockGot.mockReturnValueOnce({ json: () => Promise.reject(err) } as never);
}

describe("fetchCandles — Hyperliquid", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockGot.mockReset();
    vi.useRealTimers();
  });

  it("fetches and parses candles from HL API", async () => {
    const mockData = [
      { t: 1000, T: 1999, s: "BTC", i: "15m", o: "100", c: "105", h: "110", l: "95", v: "50", n: 20 },
      { t: 2000, T: 2999, s: "BTC", i: "15m", o: "105", c: "108", h: "112", l: "103", v: "30", n: 15 },
    ];

    mockGotJson(mockData);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "hyperliquid",
      baseUrl: "http://test",
    });

    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ t: 1000, o: 100, h: 110, l: 95, c: 105, v: 50, n: 20 });
    expect(candles[1]).toEqual({ t: 2000, o: 105, h: 112, l: 103, c: 108, v: 30, n: 15 });
  });

  it("paginates when receiving full batches", async () => {
    const batch1 = Array.from({ length: 500 }, (_, i) => ({
      t: 1000 + i * 100,
      T: 1099 + i * 100,
      s: "BTC",
      i: "15m",
      o: "100",
      c: "100",
      h: "100",
      l: "100",
      v: "10",
      n: 5,
    }));

    const batch2 = [
      { t: 60000, T: 60099, s: "BTC", i: "15m", o: "100", c: "100", h: "100", l: "100", v: "10", n: 5 },
    ];

    mockGotJson(batch1);
    mockGotJson(batch2);

    const candles = await fetchCandles("BTC", "15m", 1000, 100000, {
      source: "hyperliquid",
      baseUrl: "http://test",
      candlesPerRequest: 500,
      requestDelayMs: 0,
    });

    expect(candles).toHaveLength(501);
    expect(mockGot).toHaveBeenCalledTimes(2);
  });

  it("throws on API error", async () => {
    mockGotHttpError(500, "Internal Server Error");

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { source: "hyperliquid", baseUrl: "http://test" }),
    ).rejects.toThrow("HL API error: 500");
  });

  it("deduplicates candles by timestamp", async () => {
    const mockData = [
      { t: 1000, T: 1999, s: "BTC", i: "15m", o: "100", c: "105", h: "110", l: "95", v: "50", n: 20 },
      { t: 1000, T: 1999, s: "BTC", i: "15m", o: "100", c: "105", h: "110", l: "95", v: "50", n: 20 },
    ];

    mockGotJson(mockData);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "hyperliquid",
      baseUrl: "http://test",
    });
    expect(candles).toHaveLength(1);
  });
});

describe("fetchCandles — Bybit", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockGot.mockReset();
    vi.useRealTimers();
  });

  it("fetches and parses candles from Bybit API", async () => {
    const mockResponse = {
      retCode: 0,
      retMsg: "OK",
      result: {
        list: [
          ["2000", "105", "112", "103", "108", "30", "3150"],
          ["1000", "100", "110", "95", "105", "50", "5250"],
        ],
      },
    };

    mockGotJson(mockResponse);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "bybit",
      baseUrl: "http://test",
    });

    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ t: 1000, o: 100, h: 110, l: 95, c: 105, v: 50, n: 0 });
    expect(candles[1]).toEqual({ t: 2000, o: 105, h: 112, l: 103, c: 108, v: 30, n: 0 });
  });

  it("throws on Bybit error response", async () => {
    mockGotJson({ retCode: 10001, retMsg: "params error", result: { list: [] } });

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { source: "bybit", baseUrl: "http://test" }),
    ).rejects.toThrow("Bybit API error: params error");
  });

  it("throws on HTTP error", async () => {
    mockGotHttpError(500, "Internal Server Error");

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { source: "bybit", baseUrl: "http://test" }),
    ).rejects.toThrow("Bybit API error: 500");
  });

  it("handles empty response", async () => {
    mockGotJson({ retCode: 0, retMsg: "OK", result: { list: [] } });

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "bybit",
      baseUrl: "http://test",
    });
    expect(candles).toHaveLength(0);
  });

  it("uses correct Bybit symbol derivation", async () => {
    mockGotJson({ retCode: 0, retMsg: "OK", result: { list: [] } });

    await fetchCandles("ETH", "1h", 5000, 10000, {
      source: "bybit",
      baseUrl: "http://test",
    });

    const calledUrl = mockGot.mock.calls[0][0] as string;
    expect(calledUrl).toContain("symbol=ETHUSDT");
    expect(calledUrl).toContain("interval=60");
    expect(calledUrl).toContain("category=linear");
  });

  it("defaults to bybit source", async () => {
    mockGotJson({ retCode: 0, retMsg: "OK", result: { list: [] } });

    await fetchCandles("BTC", "15m", 1000, 5000, { baseUrl: "http://test" });

    const calledUrl = mockGot.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/v5/market/kline");
  });
});

describe("fetchCandles — Coinbase", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockGot.mockReset();
    vi.useRealTimers();
  });

  it("fetches and parses candles from Coinbase API", async () => {
    const mockData = [
      [2, 103, 112, 105, 108, 30],
      [1, 95, 110, 100, 105, 50],
    ];

    mockGotJson(mockData);

    const candles = await fetchCandles("BTC", "15m", 1000, 2000000, {
      source: "coinbase",
      baseUrl: "http://test",
    });

    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ t: 1000, o: 100, h: 110, l: 95, c: 105, v: 50, n: 0 });
    expect(candles[1]).toEqual({ t: 2000, o: 105, h: 112, l: 103, c: 108, v: 30, n: 0 });
  });

  it("uses correct product ID and granularity", async () => {
    mockGotJson([]);

    await fetchCandles("ETH", "1h", 5000, 10000, {
      source: "coinbase",
      baseUrl: "http://test",
    });

    const calledUrl = mockGot.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/products/ETH-USD/candles");
    expect(calledUrl).toContain("granularity=3600");
  });

  it("throws on unsupported interval", async () => {
    await expect(
      fetchCandles("BTC", "3m", 1000, 5000, { source: "coinbase", baseUrl: "http://test" }),
    ).rejects.toThrow("Coinbase does not support interval: 3m");
  });

  it("throws on HTTP error", async () => {
    mockGotHttpError(500, "Internal Server Error");

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { source: "coinbase", baseUrl: "http://test" }),
    ).rejects.toThrow("Coinbase API error: 500");
  });
});

describe("fetchCandles — Coinbase Perpetual", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockGot.mockReset();
    vi.useRealTimers();
  });

  it("fetches and parses candles from Coinbase Advanced Trade API", async () => {
    const mockResponse = {
      candles: [
        { start: "2", low: "103", high: "112", open: "105", close: "108", volume: "30" },
        { start: "1", low: "95", high: "110", open: "100", close: "105", volume: "50" },
      ],
    };

    mockGotJson(mockResponse);

    const candles = await fetchCandles("BTC", "15m", 1000, 2000000, {
      source: "coinbase-perp",
      baseUrl: "http://test",
    });

    expect(candles).toHaveLength(2);
    expect(candles[0]).toEqual({ t: 1000, o: 100, h: 110, l: 95, c: 105, v: 50, n: 0 });
    expect(candles[1]).toEqual({ t: 2000, o: 105, h: 112, l: 103, c: 108, v: 30, n: 0 });
  });

  it("uses correct product ID and granularity", async () => {
    mockGotJson({ candles: [] });

    await fetchCandles("ETH", "1h", 5000, 10000, {
      source: "coinbase-perp",
      baseUrl: "http://test",
    });

    const calledUrl = mockGot.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/products/ETH-PERP-INTX/candles");
    expect(calledUrl).toContain("granularity=ONE_HOUR");
  });

  it("throws on unsupported interval", async () => {
    await expect(
      fetchCandles("BTC", "3m", 1000, 5000, { source: "coinbase-perp", baseUrl: "http://test" }),
    ).rejects.toThrow("Coinbase perp does not support interval: 3m");
  });

  it("throws on HTTP error", async () => {
    mockGotHttpError(500, "Internal Server Error");

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { source: "coinbase-perp", baseUrl: "http://test" }),
    ).rejects.toThrow("Coinbase perp API error: 500");
  });

  it("handles empty response", async () => {
    mockGotJson({ candles: [] });

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "coinbase-perp",
      baseUrl: "http://test",
    });
    expect(candles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retry / timeout behaviour (got built-in retry)
// ---------------------------------------------------------------------------
describe("fetchWithRetry — HTTP error handling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockGot.mockReset();
    vi.useRealTimers();
  });

  it("does NOT retry on non-429 HTTP errors (Coinbase)", async () => {
    mockGotHttpError(500, "Internal Server Error");

    await expect(
      fetchCandles("BTC", "15m", 1000, 2000000, { source: "coinbase", baseUrl: "http://test" }),
    ).rejects.toThrow("Coinbase API error: 500");

    expect(mockGot).toHaveBeenCalledTimes(1);
  });
});

describe("fetchBybitWithRetry — body-level rate limit retry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockGot.mockReset();
    vi.useRealTimers();
  });

  it("retries on Bybit body-level Rate Limit then succeeds", async () => {
    const rateLimitResponse = {
      retCode: 10006,
      retMsg: "Too many visits! Rate Limit",
      result: { list: [] },
    };
    const successResponse = {
      retCode: 0,
      retMsg: "OK",
      result: { list: [["1000", "100", "110", "95", "105", "50", "5250"]] },
    };

    mockGotJson(rateLimitResponse);
    mockGotJson(successResponse);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "bybit",
      baseUrl: "http://test",
    });

    expect(candles).toHaveLength(1);
    expect(mockGot).toHaveBeenCalledTimes(2);
  });

  it("retries on Bybit HTTP 429 then succeeds", async () => {
    const successResponse = {
      retCode: 0,
      retMsg: "OK",
      result: { list: [["1000", "100", "110", "95", "105", "50", "5250"]] },
    };

    mockGotHttpError(429, "Too Many Requests");
    mockGotJson(successResponse);

    const candles = await fetchCandles("BTC", "15m", 1000, 5000, {
      source: "bybit",
      baseUrl: "http://test",
    });

    expect(candles).toHaveLength(1);
    expect(mockGot).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on non-rate-limit Bybit body errors", async () => {
    const errorResponse = {
      retCode: 10001,
      retMsg: "params error",
      result: { list: [] },
    };

    mockGotJson(errorResponse);

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { source: "bybit", baseUrl: "http://test" }),
    ).rejects.toThrow("Bybit API error: params error");

    expect(mockGot).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCandles — Hyperliquid with retry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    mockGot.mockReset();
    vi.useRealTimers();
  });

  it("throws on 500 from Hyperliquid API (non-retryable)", async () => {
    mockGotHttpError(500, "Internal Server Error");

    await expect(
      fetchCandles("BTC", "15m", 1000, 5000, { source: "hyperliquid", baseUrl: "http://test" }),
    ).rejects.toThrow("HL API error: 500");

    expect(mockGot).toHaveBeenCalledTimes(1);
  });
});
