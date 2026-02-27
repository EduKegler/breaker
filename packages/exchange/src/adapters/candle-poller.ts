import { fetchCandles, intervalToMs } from "@breaker/backtest";
import type { Candle, CandleInterval, DataSource } from "@breaker/backtest";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("candlePoller");

function isValidCandle(c: Candle): boolean {
  return Number.isFinite(c.c) && c.c > 0
    && Number.isFinite(c.o) && c.o > 0
    && Number.isFinite(c.h) && Number.isFinite(c.l)
    && c.h >= c.l;
}

interface CandlePollerConfig {
  coin: string;
  interval: CandleInterval;
  dataSource: DataSource;
}

export class CandlePoller {
  private config: CandlePollerConfig;
  private candles: Candle[] = [];

  constructor(config: CandlePollerConfig) {
    this.config = config;
  }

  async warmup(bars: number): Promise<Candle[]> {
    const ivlMs = intervalToMs(this.config.interval);
    const endTime = Date.now();
    const startTime = endTime - bars * ivlMs;

    const t0 = performance.now();
    const raw = await fetchCandles(
      this.config.coin,
      this.config.interval,
      startTime,
      endTime,
      { source: this.config.dataSource },
    );
    const beforeCount = raw.length;
    this.candles = raw.filter(isValidCandle);
    const discarded = beforeCount - this.candles.length;
    if (discarded > 0) {
      log.warn({ action: "warmup", coin: this.config.coin, discarded }, "Discarded invalid candles during warmup");
    }
    log.info({ action: "warmup", coin: this.config.coin, requestedBars: bars, receivedBars: this.candles.length, latencyMs: Math.round(performance.now() - t0) }, "Warmup complete");

    return this.candles;
  }

  async poll(): Promise<Candle | null> {
    const ivlMs = intervalToMs(this.config.interval);
    const lastTs = this.candles.length > 0
      ? this.candles[this.candles.length - 1].t
      : Date.now() - ivlMs * 2;

    // Fetch from the CURRENT candle onwards (not lastTs + ivlMs) so we also
    // get the in-progress candle with updated OHLCV values.
    const t0 = performance.now();
    const newCandles = await fetchCandles(
      this.config.coin,
      this.config.interval,
      lastTs,
      Date.now(),
      { source: this.config.dataSource },
    );

    if (newCandles.length === 0) return null;

    const validCandles = newCandles.filter(isValidCandle);
    if (validCandles.length < newCandles.length) {
      log.warn({ action: "poll", coin: this.config.coin, discarded: newCandles.length - validCandles.length }, "Discarded invalid candles during poll");
    }
    if (validCandles.length === 0) return null;

    for (const c of validCandles) {
      const idx = this.candles.findIndex((existing) => existing.t === c.t);
      if (idx >= 0) {
        // Update in-progress candle (OHLCV may have changed)
        this.candles[idx] = c;
      } else {
        this.candles.push(c);
      }
    }

    log.debug({ action: "poll", coin: this.config.coin, newCandles: validCandles.length, totalCandles: this.candles.length, latencyMs: Math.round(performance.now() - t0) }, "Candles polled");

    return validCandles[validCandles.length - 1];
  }

  getCandles(): Candle[] {
    return this.candles;
  }

  getLatest(): Candle | null {
    return this.candles.length > 0 ? this.candles[this.candles.length - 1] : null;
  }

  async fetchHistorical(before: number, limit: number): Promise<Candle[]> {
    const ivlMs = intervalToMs(this.config.interval);
    const endTime = before;
    const startTime = endTime - limit * ivlMs;

    const t0 = performance.now();
    const candles = await fetchCandles(
      this.config.coin,
      this.config.interval,
      startTime,
      endTime,
      { source: this.config.dataSource },
    );
    log.debug({ action: "fetchHistorical", coin: this.config.coin, before, limit, received: candles.length, latencyMs: Math.round(performance.now() - t0) }, "Historical candles fetched");
    return candles;
  }
}
