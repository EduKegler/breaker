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

    const newCandles = await fetchCandles(
      this.config.coin,
      this.config.interval,
      lastTs + ivlMs,
      Date.now(),
      { source: this.config.dataSource },
    );

    if (newCandles.length === 0) return null;

    for (const c of newCandles) {
      if (!this.candles.some((existing) => existing.t === c.t)) {
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
}
