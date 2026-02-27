import { fetchCandles, intervalToMs } from "@breaker/backtest";
import type { Candle, CandleInterval, DataSource } from "@breaker/backtest";

export interface CandlePollerConfig {
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

    this.candles = await fetchCandles(
      this.config.coin,
      this.config.interval,
      startTime,
      endTime,
      { source: this.config.dataSource },
    );

    return this.candles;
  }

  async poll(): Promise<Candle | null> {
    const ivlMs = intervalToMs(this.config.interval);
    const lastTs = this.candles.length > 0
      ? this.candles[this.candles.length - 1].t
      : Date.now() - ivlMs * 2;

    // Fetch from the CURRENT candle onwards (not lastTs + ivlMs) so we also
    // get the in-progress candle with updated OHLCV values.
    const newCandles = await fetchCandles(
      this.config.coin,
      this.config.interval,
      lastTs,
      Date.now(),
      { source: this.config.dataSource },
    );

    if (newCandles.length === 0) return null;

    for (const c of newCandles) {
      const idx = this.candles.findIndex((existing) => existing.t === c.t);
      if (idx >= 0) {
        // Update in-progress candle (OHLCV may have changed)
        this.candles[idx] = c;
      } else {
        this.candles.push(c);
      }
    }

    return newCandles[newCandles.length - 1];
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

    return fetchCandles(
      this.config.coin,
      this.config.interval,
      startTime,
      endTime,
      { source: this.config.dataSource },
    );
  }
}
