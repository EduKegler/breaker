import { describe, it, expect, vi } from "vitest";
import { fetchCandlesForReplay, SIGNAL_WINDOW } from "./fetch-candles-for-replay.js";
import type { Candle, CandleCache, DataSource } from "@breaker/backtest";
import type { CandleStreamer } from "../adapters/candle-streamer.js";

const dataSource: DataSource = "binance";

const makeCandle = (t: number): Candle => ({ t, o: 100, h: 105, l: 95, c: 102, v: 1000, n: 0 });

describe("fetchCandlesForReplay", () => {
  it("uses candleCache when available", async () => {
    const candles = [makeCandle(1000), makeCandle(2000)];
    const candleCache = {
      sync: vi.fn(),
      getCandles: vi.fn(() => candles),
    } as unknown as CandleCache;

    const result = await fetchCandlesForReplay(
      { candleCache, streamers: new Map(), dataSource },
      "SOL",
      "15m",
      Date.now(),
      100,
    );

    expect(candleCache.sync).toHaveBeenCalledTimes(1);
    expect(candleCache.getCandles).toHaveBeenCalledTimes(1);
    expect(result).toBe(candles);
  });

  it("falls back to streamer when no cache", async () => {
    const candles = [makeCandle(3000)];
    const streamer = { fetchHistorical: vi.fn(async () => candles) } as unknown as CandleStreamer;
    const streamers = new Map([["SOL:15m", streamer]]);

    const result = await fetchCandlesForReplay(
      { streamers, dataSource },
      "SOL",
      "15m",
      Date.now(),
      100,
    );

    expect(streamer.fetchHistorical).toHaveBeenCalledTimes(1);
    expect(result).toBe(candles);
  });

  it("returns empty array when no cache and no streamer", async () => {
    const result = await fetchCandlesForReplay(
      { streamers: new Map(), dataSource },
      "SOL",
      "15m",
      Date.now(),
      100,
    );

    expect(result).toEqual([]);
  });

  it("exports SIGNAL_WINDOW constant", () => {
    expect(SIGNAL_WINDOW).toBe(10_000);
  });
});
