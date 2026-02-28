import { EventEmitter } from "node:events";
import { fetchCandles, streamCandles, intervalToMs } from "@breaker/backtest";
import type { Candle, CandleInterval, DataSource, StreamCandlesOptions } from "@breaker/backtest";
import { logger } from "../lib/logger.js";

const log = logger.createChild("candleStreamer");

function isValidCandle(c: Candle): boolean {
  return Number.isFinite(c.c) && c.c > 0
    && Number.isFinite(c.o) && c.o > 0
    && Number.isFinite(c.h) && Number.isFinite(c.l)
    && c.h >= c.l;
}

export interface CandleStreamerConfig {
  coin: string;
  interval: CandleInterval;
  dataSource: DataSource;
}

export interface CandleStreamerEvents {
  "candle:tick": [candle: Candle];
  "candle:close": [candle: Candle];
  "stale": [info: { lastCandleAt: number; silentMs: number }];
}

export declare interface CandleStreamer {
  on<K extends keyof CandleStreamerEvents>(event: K, listener: (...args: CandleStreamerEvents[K]) => void): this;
  emit<K extends keyof CandleStreamerEvents>(event: K, ...args: CandleStreamerEvents[K]): boolean;
}

const STALE_THRESHOLD_MULTIPLIER = 3;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export class CandleStreamer extends EventEmitter {
  private config: CandleStreamerConfig;
  private candles: Candle[] = [];
  private abortController: AbortController | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCandleAt = 0;
  private reconnectAttempt = 0;
  private running = false;

  /** @internal — override for testing */
  _streamOverride?: typeof streamCandles;

  constructor(config: CandleStreamerConfig) {
    super();
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
    log.info({
      action: "warmup",
      coin: this.config.coin,
      requestedBars: bars,
      receivedBars: this.candles.length,
      latencyMs: Math.round(performance.now() - t0),
    }, "Warmup complete");

    return this.candles;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectLoop().catch((err) => {
      log.error({ err }, "Reconnect loop fatal error");
    });
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.clearStaleTimer();
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
    log.debug({
      action: "fetchHistorical",
      coin: this.config.coin,
      before,
      limit,
      received: candles.length,
      latencyMs: Math.round(performance.now() - t0),
    }, "Historical candles fetched");
    return candles;
  }

  private async reconnectLoop(): Promise<void> {
    const { coin, interval, dataSource } = this.config;
    const streamFn = this._streamOverride ?? streamCandles;

    while (this.running) {
      this.abortController = new AbortController();
      try {
        this.reconnectAttempt++;
        if (this.reconnectAttempt > 1) {
          log.warn({ attempt: this.reconnectAttempt, coin }, "WS reconnecting");
        }

        this.resetStaleTimer();

        await streamFn(coin, interval, {
          source: dataSource,
          signal: this.abortController.signal,
          onCandle: (candle, isClosed) => {
            this.reconnectAttempt = 0;
            if (!isValidCandle(candle)) return;
            this.upsertCandle(candle);
            this.resetStaleTimer();
            this.lastCandleAt = candle.t;

            if (isClosed) {
              this.emit("candle:close", candle);
            }
            this.emit("candle:tick", candle);
          },
        } satisfies StreamCandlesOptions);

        // streamCandles returned normally (signal aborted)
        break;
      } catch (err) {
        if (!this.running) break;
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
          MAX_RECONNECT_DELAY_MS,
        );
        log.error({ err, coin, delay, attempt: this.reconnectAttempt }, "WS stream error, reconnecting");
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    this.clearStaleTimer();
  }

  private resetStaleTimer(): void {
    this.clearStaleTimer();
    const thresholdMs = STALE_THRESHOLD_MULTIPLIER * intervalToMs(this.config.interval);
    this.staleTimer = setTimeout(() => {
      const silentMs = Date.now() - this.lastCandleAt;
      log.warn({ coin: this.config.coin, silentMs }, "Candle stream stale");
      this.emit("stale", { lastCandleAt: this.lastCandleAt, silentMs });
    }, thresholdMs);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private upsertCandle(c: Candle): void {
    const idx = this.candles.findIndex((x) => x.t === c.t);
    if (idx >= 0) {
      this.candles[idx] = c;
    } else {
      this.candles.push(c);
    }
  }
}
