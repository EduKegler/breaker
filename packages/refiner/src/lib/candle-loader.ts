import { CandleCache } from "@breaker/backtest";
import type { Candle, CandleInterval, DataSource } from "@breaker/backtest";

export interface LoadCandlesOptions {
  coin: string;
  source: DataSource;
  interval: CandleInterval;
  startTime: number;
  endTime: number;
  dbPath: string;
}

/**
 * Sync candles from remote source into SQLite cache, then return them.
 * Call once per session to avoid redundant API calls.
 */
export async function loadCandles(opts: LoadCandlesOptions): Promise<Candle[]> {
  const { coin, source, interval, startTime, endTime, dbPath } = opts;
  const cache = new CandleCache(dbPath);

  try {
    const syncResult = await cache.sync(coin, interval, startTime, endTime, { source });
    const candles = cache.getCandles(coin, interval, startTime, endTime, source);

    if (candles.length === 0) {
      throw new Error(
        `No candles loaded for ${coin}/${interval} from ${source} ` +
        `(${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}). ` +
        `Sync returned: fetched=${syncResult.fetched}, cached=${syncResult.cached}`,
      );
    }

    return candles;
  } finally {
    cache.close();
  }
}
