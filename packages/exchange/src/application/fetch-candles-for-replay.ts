import { intervalToMs } from "@breaker/backtest";
import type { Candle, CandleInterval, CandleCache, DataSource } from "@breaker/backtest";
import type { CandleStreamer } from "../adapters/candle-streamer.js";

/** How many bars of signals to display beyond warmup (~104 days on 15m). */
export const SIGNAL_WINDOW = 10_000;

export interface FetchCandlesForReplayDeps {
  candleCache?: CandleCache;
  streamers: Map<string, CandleStreamer>;
  dataSource: DataSource;
}

/** Fetch candles using SQLite cache (sync → read) or streamer fallback. */
export async function fetchCandlesForReplay(
  deps: FetchCandlesForReplayDeps,
  coin: string,
  interval: CandleInterval,
  endTime: number,
  bars: number,
): Promise<Candle[]> {
  const ivlMs = intervalToMs(interval);
  const startTime = endTime - bars * ivlMs;

  if (deps.candleCache) {
    await deps.candleCache.sync(coin, interval, startTime, endTime, { source: deps.dataSource });
    return deps.candleCache.getCandles(coin, interval, startTime, endTime, deps.dataSource);
  }

  const streamer = deps.streamers.get(`${coin}:${interval}`);
  if (streamer) return streamer.fetchHistorical(endTime, bars);

  return [];
}
