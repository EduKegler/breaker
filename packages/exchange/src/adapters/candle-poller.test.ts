import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Candle } from "@breaker/backtest";

vi.mock("@breaker/backtest", async () => {
  const actual = await vi.importActual<typeof import("@breaker/backtest")>("@breaker/backtest");
  return {
    ...actual,
    fetchCandles: vi.fn(),
  };
});

import { fetchCandles } from "@breaker/backtest";
import { CandlePoller } from "./candle-poller.js";

const mockFetch = vi.mocked(fetchCandles);

const makeCandle = (i: number): Candle => ({
  t: 1700000000000 + i * 900_000, // 15m intervals
  o: 100 + i,
  h: 105 + i,
  l: 95 + i,
  c: 102 + i,
  v: 1000,
  n: 50,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CandlePoller", () => {
  const config = { coin: "BTC", interval: "15m" as const, dataSource: "binance" as const };

  it("warms up with historical candles", async () => {
    const candles = [makeCandle(0), makeCandle(1), makeCandle(2)];
    mockFetch.mockResolvedValueOnce(candles);

    const poller = new CandlePoller(config);
    const result = await poller.warmup(200);

    expect(result).toHaveLength(3);
    expect(poller.getCandles()).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("polls for new candles after warmup", async () => {
    const warmupCandles = [makeCandle(0), makeCandle(1)];
    mockFetch.mockResolvedValueOnce(warmupCandles);

    const poller = new CandlePoller(config);
    await poller.warmup(200);

    const newCandle = makeCandle(2);
    mockFetch.mockResolvedValueOnce([newCandle]);

    const result = await poller.poll();
    expect(result).toEqual(newCandle);
    expect(poller.getCandles()).toHaveLength(3);
  });

  it("returns null when no new candles available", async () => {
    mockFetch.mockResolvedValueOnce([makeCandle(0)]);

    const poller = new CandlePoller(config);
    await poller.warmup(200);

    mockFetch.mockResolvedValueOnce([]);

    const result = await poller.poll();
    expect(result).toBeNull();
  });

  it("deduplicates candles on poll", async () => {
    const candle0 = makeCandle(0);
    mockFetch.mockResolvedValueOnce([candle0]);

    const poller = new CandlePoller(config);
    await poller.warmup(200);

    // Return same candle again
    mockFetch.mockResolvedValueOnce([candle0, makeCandle(1)]);

    await poller.poll();
    expect(poller.getCandles()).toHaveLength(2);
  });

  it("getLatest returns last candle", async () => {
    mockFetch.mockResolvedValueOnce([makeCandle(0), makeCandle(1)]);

    const poller = new CandlePoller(config);
    await poller.warmup(200);

    const latest = poller.getLatest();
    expect(latest?.t).toBe(makeCandle(1).t);
  });

  it("getLatest returns null when empty", () => {
    const poller = new CandlePoller(config);
    expect(poller.getLatest()).toBeNull();
  });
});
