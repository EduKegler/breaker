import { describe, it, expect, vi } from "vitest";
import { streamCandles, type ProExchange } from "./stream-candles.js";
import type { Candle } from "../types/candle.js";

type OHLCVRow = [number, number, number, number, number, number];

function row(ts: number, close = 100): OHLCVRow {
  return [ts, 100, 105, 95, close, 1000];
}

function createMockExchange(batches: OHLCVRow[][]): ProExchange {
  let callIndex = 0;
  return {
    watchOHLCV: vi.fn().mockImplementation(async () => {
      if (callIndex < batches.length) {
        return batches[callIndex++];
      }
      // After exhausting batches, wait indefinitely (will be aborted)
      return new Promise<OHLCVRow[]>(() => {});
    }),
  };
}

describe("streamCandles", () => {
  it("emits in-progress candle on each update", async () => {
    const ts = 1700000000000;
    const exchange = createMockExchange([
      [row(ts, 100)],
      [row(ts, 101)],
    ]);

    const ac = new AbortController();
    const calls: Array<{ candle: Candle; isClosed: boolean }> = [];

    const promise = streamCandles("BTC", "15m", {
      _exchange: exchange,
      signal: ac.signal,
      onCandle: (candle, isClosed) => {
        calls.push({ candle: { ...candle }, isClosed });
        if (calls.length >= 2) ac.abort();
      },
    });
    await promise;

    expect(calls).toHaveLength(2);
    // Both should be in-progress (same timestamp)
    expect(calls[0].isClosed).toBe(false);
    expect(calls[0].candle.c).toBe(100);
    expect(calls[1].isClosed).toBe(false);
    expect(calls[1].candle.c).toBe(101);
  });

  it("detects candle close when timestamp changes", async () => {
    const ts1 = 1700000000000;
    const ts2 = 1700000900000; // 15m later
    const exchange = createMockExchange([
      [row(ts1, 100)],
      [row(ts1, 102)], // update in progress
      [row(ts2, 103)], // new timestamp → close previous
    ]);

    const ac = new AbortController();
    const calls: Array<{ candle: Candle; isClosed: boolean }> = [];

    const promise = streamCandles("BTC", "15m", {
      _exchange: exchange,
      signal: ac.signal,
      onCandle: (candle, isClosed) => {
        calls.push({ candle: { ...candle }, isClosed });
        if (calls.length >= 4) ac.abort();
      },
    });
    await promise;

    // Call sequence:
    // 1. ts1 close=100, isClosed=false (first update)
    // 2. ts1 close=102, isClosed=false (second update, same ts)
    // 3. ts1 close=102, isClosed=true  (close detected when ts2 arrives)
    // 4. ts2 close=103, isClosed=false (new candle in progress)
    expect(calls).toHaveLength(4);
    expect(calls[2].isClosed).toBe(true);
    expect(calls[2].candle.t).toBe(ts1);
    expect(calls[2].candle.c).toBe(102);
    expect(calls[3].isClosed).toBe(false);
    expect(calls[3].candle.t).toBe(ts2);
  });

  it("skips empty OHLCV arrays", async () => {
    const ts = 1700000000000;
    const exchange = createMockExchange([
      [],          // empty → skip
      [row(ts, 100)],
    ]);

    const ac = new AbortController();
    const calls: Array<{ candle: Candle; isClosed: boolean }> = [];

    const promise = streamCandles("BTC", "15m", {
      _exchange: exchange,
      signal: ac.signal,
      onCandle: (candle, isClosed) => {
        calls.push({ candle: { ...candle }, isClosed });
        ac.abort();
      },
    });
    await promise;

    expect(calls).toHaveLength(1);
    expect(calls[0].candle.c).toBe(100);
  });

  it("throws for unsupported interval", async () => {
    const exchange = createMockExchange([]);

    await expect(
      streamCandles("BTC", "99m" as any, {
        _exchange: exchange,
        signal: new AbortController().signal,
        onCandle: () => {},
      }),
    ).rejects.toThrow("Unsupported interval: 99m");
  });

  it("stops when AbortSignal is aborted before first call", async () => {
    const exchange = createMockExchange([]);
    const ac = new AbortController();
    ac.abort(); // abort immediately

    const onCandle = vi.fn();
    await streamCandles("BTC", "15m", {
      _exchange: exchange,
      signal: ac.signal,
      onCandle,
    });

    expect(onCandle).not.toHaveBeenCalled();
  });
});
