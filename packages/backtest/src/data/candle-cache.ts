import Database from "better-sqlite3";
import type { Candle, CandleInterval } from "../types/candle.js";
import { fetchCandles, type CandleClientOptions } from "./candle-client.js";
import { intervalToMs } from "../types/candle.js";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS candles (
    source TEXT NOT NULL DEFAULT 'bybit',
    coin TEXT NOT NULL,
    interval TEXT NOT NULL,
    t INTEGER NOT NULL,
    o REAL NOT NULL,
    h REAL NOT NULL,
    l REAL NOT NULL,
    c REAL NOT NULL,
    v REAL NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (source, coin, interval, t)
  );

  CREATE TABLE IF NOT EXISTS sync_meta (
    source TEXT NOT NULL DEFAULT 'bybit',
    coin TEXT NOT NULL,
    interval TEXT NOT NULL,
    last_timestamp INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, coin, interval)
  );
`;

export class CandleCache {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Get candles from cache for a source/coin/interval/time range.
   */
  getCandles(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
    source = "bybit",
  ): Candle[] {
    const stmt = this.db.prepare(
      `SELECT t, o, h, l, c, v, n FROM candles
       WHERE source = ? AND coin = ? AND interval = ? AND t >= ? AND t <= ?
       ORDER BY t ASC`,
    );
    return stmt.all(source, coin, interval, startTime, endTime) as Candle[];
  }

  /**
   * Insert candles into cache (upsert).
   */
  insertCandles(coin: string, interval: CandleInterval, candles: Candle[], source = "bybit"): void {
    if (candles.length === 0) return;

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO candles (source, coin, interval, t, o, h, l, c, v, n)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertMany = this.db.transaction((rows: Candle[]) => {
      for (const c of rows) {
        insert.run(source, coin, interval, c.t, c.o, c.h, c.l, c.c, c.v, c.n);
      }
    });

    insertMany(candles);

    // Update sync_meta (only advance last_timestamp, never go backward)
    const maxTs = Math.max(...candles.map((c) => c.t));
    const currentLast = this.getLastTimestamp(coin, interval, source);
    if (currentLast === null || maxTs > currentLast) {
      this.db.prepare(
        `INSERT OR REPLACE INTO sync_meta (source, coin, interval, last_timestamp, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(source, coin, interval, maxTs);
    }
  }

  /**
   * Get the last cached timestamp for a coin/interval.
   */
  getLastTimestamp(coin: string, interval: CandleInterval, source = "bybit"): number | null {
    const row = this.db.prepare(
      `SELECT last_timestamp FROM sync_meta WHERE source = ? AND coin = ? AND interval = ?`,
    ).get(source, coin, interval) as { last_timestamp: number } | undefined;
    return row?.last_timestamp ?? null;
  }

  /**
   * Get the earliest cached timestamp for a coin/interval.
   */
  getFirstTimestamp(coin: string, interval: CandleInterval, source = "bybit"): number | null {
    const row = this.db.prepare(
      `SELECT MIN(t) as first_t FROM candles WHERE source = ? AND coin = ? AND interval = ?`,
    ).get(source, coin, interval) as { first_t: number | null };
    return row.first_t ?? null;
  }

  /**
   * Get candle count for a coin/interval.
   */
  getCandleCount(coin: string, interval: CandleInterval, source = "bybit"): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM candles WHERE source = ? AND coin = ? AND interval = ?`,
    ).get(source, coin, interval) as { cnt: number };
    return row.cnt;
  }

  /**
   * Sync candles from API and store in cache.
   * Handles both backfill (earlier data) and incremental (newer data).
   */
  async sync(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
    clientOptions?: CandleClientOptions,
  ): Promise<{ fetched: number; cached: number }> {
    let totalFetched = 0;
    const ivlMs = intervalToMs(interval);
    const source = clientOptions?.source ?? "bybit";
    const firstTs = this.getFirstTimestamp(coin, interval, source);
    const lastTs = this.getLastTimestamp(coin, interval, source);

    if (firstTs === null || lastTs === null) {
      // No cached data — full fetch
      const candles = await fetchCandles(coin, interval, startTime, endTime, clientOptions);
      this.insertCandles(coin, interval, candles, source);
      totalFetched = candles.length;
    } else {
      // Backfill: fetch earlier data if cache starts after requested startTime
      if (startTime < firstTs) {
        const backfillCandles = await fetchCandles(coin, interval, startTime, firstTs - 1, clientOptions);
        this.insertCandles(coin, interval, backfillCandles, source);
        totalFetched += backfillCandles.length;
      }

      // Forward fill: fetch newer data after last cached timestamp
      const forwardStart = lastTs + ivlMs;
      if (forwardStart < endTime) {
        const forwardCandles = await fetchCandles(coin, interval, forwardStart, endTime, clientOptions);
        this.insertCandles(coin, interval, forwardCandles, source);
        totalFetched += forwardCandles.length;
      }
    }

    return {
      fetched: totalFetched,
      cached: this.getCandleCount(coin, interval, source),
    };
  }
}
