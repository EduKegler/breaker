import ccxt from "ccxt";
import type { Candle, CandleInterval } from "../types/candle.js";
import { toSymbol, type DataSource } from "./to-symbol.js";

type OHLCVRow = [number, number, number, number, number, number];

export interface ProExchange {
  watchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number): Promise<OHLCVRow[]>;
  close?(): Promise<void>;
}

export interface StreamCandlesOptions {
  source?: DataSource;
  ccxtSymbol?: string;
  onCandle: (candle: Candle, isClosed: boolean) => void;
  signal?: AbortSignal;
  /** @internal — injected pro exchange instance for tests */
  _exchange?: ProExchange;
}

const EXCHANGE_MAP: Record<DataSource, string> = {
  binance: "binanceusdm",
  hyperliquid: "hyperliquid",
};

/** CCXT interval strings (same as our CandleInterval for common ones). */
const CCXT_TIMEFRAME: Record<string, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "8h": "8h", "12h": "12h",
  "1d": "1d", "3d": "3d", "1w": "1w", "1M": "1M",
};

/** Cache of pro exchange instances (separate from REST cache). */
const proExchangeCache = new Map<string, ProExchange>();

function getProExchange(source: DataSource): ProExchange {
  const id = EXCHANGE_MAP[source];
  let exchange = proExchangeCache.get(id);
  if (!exchange) {
    const pro = (ccxt as unknown as { pro: Record<string, new (config: Record<string, unknown>) => ProExchange> }).pro;
    exchange = new pro[id]({ enableRateLimit: true });
    proExchangeCache.set(id, exchange);
  }
  return exchange;
}

function parseOhlcvRow(bar: OHLCVRow): Candle {
  return {
    t: bar[0],
    o: bar[1],
    h: bar[2],
    l: bar[3],
    c: bar[4],
    v: bar[5],
    n: 0,
  };
}

/**
 * Stream candles in real-time via CCXT pro WebSocket.
 *
 * Opens a watchOHLCV connection and calls `onCandle` for each update.
 * Detects candle close when a new timestamp appears (the previous
 * candle's last-seen values become final).
 *
 * The function runs until `signal` is aborted or an unrecoverable error occurs.
 * Reconnection/retry is the caller's responsibility (see CandleStreamer).
 */
export async function streamCandles(
  coin: string,
  interval: CandleInterval,
  options: StreamCandlesOptions,
): Promise<void> {
  const source = options.source ?? "binance";
  const exchange = options._exchange ?? getProExchange(source);
  const symbol = options.ccxtSymbol ?? toSymbol(coin, source);
  const timeframe = CCXT_TIMEFRAME[interval];
  if (!timeframe) throw new Error(`Unsupported interval: ${interval}`);

  let prevLastTs = 0;
  let prevLastCandle: Candle | null = null;

  while (!options.signal?.aborted) {
    const ohlcv = await exchange.watchOHLCV(symbol, timeframe);
    if (options.signal?.aborted) break;
    if (ohlcv.length === 0) continue;

    const lastBar = ohlcv[ohlcv.length - 1];
    const lastTs = lastBar[0];

    // Detect candle close: new timestamp means previous candle is finalized
    if (prevLastTs > 0 && lastTs > prevLastTs && prevLastCandle) {
      options.onCandle(prevLastCandle, true);
    }

    // Emit the current (in-progress) candle
    const currentCandle = parseOhlcvRow(lastBar);
    options.onCandle(currentCandle, false);

    prevLastTs = lastTs;
    prevLastCandle = currentCandle;
  }
}
