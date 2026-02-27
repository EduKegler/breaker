import ccxt, { type Exchange } from "ccxt";
import { setTimeout as sleep } from "node:timers/promises";
import type { Candle, CandleInterval } from "../types/candle.js";
import { intervalToMs } from "../types/candle.js";

export type DataSource = "binance" | "hyperliquid";

export interface CandleClientOptions {
  source?: DataSource;
  candlesPerRequest?: number;
  requestDelayMs?: number;
  /** Override the CCXT symbol (e.g. "BTC/USDT:USDT") */
  ccxtSymbol?: string;
  /** @internal — injected exchange instance for tests */
  _exchange?: Exchange;
}

const EXCHANGE_MAP: Record<DataSource, string> = {
  binance: "binanceusdm",
  hyperliquid: "hyperliquid",
};

const DEFAULT_LIMIT: Record<DataSource, number> = {
  binance: 1500,
  hyperliquid: 500,
};

const DEFAULT_DELAY: Record<DataSource, number> = {
  binance: 200,
  hyperliquid: 200,
};

/** Map coin + source to CCXT unified symbol. */
export function toSymbol(coin: string, source: DataSource): string {
  switch (source) {
    case "binance":
      return `${coin}/USDT:USDT`;
    case "hyperliquid":
      return `${coin}/USDC:USDC`;
  }
}

/** CCXT interval strings (same as our CandleInterval for common ones). */
const CCXT_TIMEFRAME: Record<string, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "8h": "8h", "12h": "12h",
  "1d": "1d", "3d": "3d", "1w": "1w", "1M": "1M",
};

/** Cache of exchange instances (one per exchange ID). */
const exchangeCache = new Map<string, Exchange>();

function getExchange(source: DataSource): Exchange {
  const id = EXCHANGE_MAP[source];
  let exchange = exchangeCache.get(id);
  if (!exchange) {
    const ExchangeClass = (ccxt as unknown as Record<string, new (config: Record<string, unknown>) => Exchange>)[id];
    exchange = new ExchangeClass({ enableRateLimit: true });
    exchangeCache.set(id, exchange);
  }
  return exchange;
}

/** Deduplicate candles by timestamp and sort oldest-first. */
function deduplicateCandles(candles: Candle[]): Candle[] {
  const seen = new Set<number>();
  return candles
    .filter((c) => {
      if (seen.has(c.t)) return false;
      seen.add(c.t);
      return true;
    })
    .sort((a, b) => a.t - b.t);
}

/**
 * Fetch candles with pagination via CCXT's fetchOHLCV.
 */
export async function fetchCandles(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
  options: CandleClientOptions = {},
): Promise<Candle[]> {
  const source = options.source ?? "binance";
  const exchange = options._exchange ?? getExchange(source);
  const symbol = options.ccxtSymbol ?? toSymbol(coin, source);
  const timeframe = CCXT_TIMEFRAME[interval];
  if (!timeframe) throw new Error(`Unsupported interval: ${interval}`);

  const limit = options.candlesPerRequest ?? DEFAULT_LIMIT[source];
  const delay = options.requestDelayMs ?? DEFAULT_DELAY[source];
  const ivlMs = intervalToMs(interval);

  const allCandles: Candle[] = [];
  let since = startTime;

  while (since < endTime) {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    if (ohlcv.length === 0) break;

    for (const bar of ohlcv) {
      const t = bar[0] as number;
      if (t > endTime) break;
      allCandles.push({
        t,
        o: bar[1] as number,
        h: bar[2] as number,
        l: bar[3] as number,
        c: bar[4] as number,
        v: bar[5] as number,
        n: 0,
      });
    }

    const lastTs = ohlcv[ohlcv.length - 1][0] as number;
    if (lastTs <= since) break; // no progress — avoid infinite loop

    if (ohlcv.length >= limit) {
      since = lastTs + ivlMs;
      await sleep(delay);
    } else {
      break;
    }
  }

  return deduplicateCandles(allCandles);
}
