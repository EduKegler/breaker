import type { Candle, CandleInterval } from "../types/candle.js";

export type DataSource = "hyperliquid" | "bybit" | "coinbase" | "coinbase-perp";

export interface CandleClientOptions {
  source?: DataSource;
  baseUrl?: string;
  candlesPerRequest?: number;
  requestDelayMs?: number;
  /** Bybit symbol override (default: derives from coin, e.g. "BTC" → "BTCUSDT") */
  bybitSymbol?: string;
  /** Bybit category: "linear" (USDT perp) | "inverse" (default: "linear") */
  bybitCategory?: string;
  /** Coinbase product ID override (default: derives from coin, e.g. "BTC" → "BTC-USD") */
  coinbaseProductId?: string;
  /** Coinbase Advanced Trade product ID override (default: derives from coin, e.g. "BTC" → "BTC-PERP-INTX") */
  coinbasePerpProductId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with automatic retry on HTTP 429. Backoff: 2s, 4s, 6s.
 * Throws immediately on non-429 errors.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  label: string,
): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    lastResponse = await fetch(url, init);
    if (lastResponse.ok) return lastResponse;
    if (lastResponse.status === 429) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`${label} API error: ${lastResponse.status} ${lastResponse.statusText}`);
  }
  throw new Error(`${label} API error: rate limit exceeded after retries`);
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
 * Fetch candles with pagination. Delegates to HL or Bybit based on options.source.
 */
export async function fetchCandles(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
  options: CandleClientOptions = {},
): Promise<Candle[]> {
  const source = options.source ?? "bybit";
  if (source === "coinbase-perp") {
    return fetchCoinbasePerp(coin, interval, startTime, endTime, options);
  }
  if (source === "coinbase") {
    return fetchCoinbase(coin, interval, startTime, endTime, options);
  }
  if (source === "bybit") {
    return fetchBybit(coin, interval, startTime, endTime, options);
  }
  return fetchHyperliquid(coin, interval, startTime, endTime, options);
}

// ── Bybit ───────────────────────────────────────────────────────────

const BYBIT_BASE = "https://api.bybit.com";
const BYBIT_LIMIT = 1000;

/** Map our CandleInterval to Bybit interval string */
function toBybitInterval(interval: CandleInterval): string {
  const map: Record<string, string> = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "2h": "120", "4h": "240", "8h": "480", "12h": "720",
    "1d": "D", "3d": "D", "1w": "W", "1M": "M",
  };
  return map[interval] ?? interval;
}

type BybitResponse = { retCode: number; retMsg: string; result: { list: string[][] } };

/** Bybit-specific retry: also retries on retMsg "Rate Limit" (200 OK but body-level error). */
async function fetchBybitWithRetry(url: string): Promise<BybitResponse> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`Bybit API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as BybitResponse;
    if (json.retCode !== 0) {
      if (json.retMsg.includes("Rate Limit")) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`Bybit API error: ${json.retMsg}`);
    }
    return json;
  }
  throw new Error(`Bybit API error: rate limit exceeded after retries`);
}

async function fetchBybit(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
  options: CandleClientOptions,
): Promise<Candle[]> {
  const baseUrl = options.baseUrl ?? BYBIT_BASE;
  const limit = options.candlesPerRequest ?? BYBIT_LIMIT;
  const delay = options.requestDelayMs ?? 500;
  const symbol = options.bybitSymbol ?? `${coin}USDT`;
  const category = options.bybitCategory ?? "linear";
  const ivl = toBybitInterval(interval);

  const allCandles: Candle[] = [];
  let currentEnd = endTime;

  while (currentEnd > startTime) {
    const url =
      `${baseUrl}/v5/market/kline?category=${category}&symbol=${symbol}` +
      `&interval=${ivl}&start=${startTime}&end=${currentEnd}&limit=${limit}`;

    const json = await fetchBybitWithRetry(url);
    const list = json.result.list;
    if (list.length === 0) break;

    // Bybit returns newest-first, reverse to oldest-first
    for (let i = list.length - 1; i >= 0; i--) {
      const raw = list[i];
      allCandles.push({
        t: parseInt(raw[0]),
        o: parseFloat(raw[1]),
        h: parseFloat(raw[2]),
        l: parseFloat(raw[3]),
        c: parseFloat(raw[4]),
        v: parseFloat(raw[5]),
        n: 0,
      });
    }

    const oldestTs = parseInt(list[list.length - 1][0]);

    if (list.length >= limit) {
      if (oldestTs >= currentEnd) break;
      currentEnd = oldestTs - 1;
      await sleep(delay);
    } else {
      break;
    }
  }

  return deduplicateCandles(allCandles);
}

// ── Hyperliquid ─────────────────────────────────────────────────────

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_LIMIT = 500;

async function fetchHyperliquid(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
  options: CandleClientOptions,
): Promise<Candle[]> {
  const baseUrl = options.baseUrl ?? HL_INFO_URL;
  const limit = options.candlesPerRequest ?? HL_LIMIT;
  const delay = options.requestDelayMs ?? 200;

  const allCandles: Candle[] = [];
  let currentStart = startTime;

  while (currentStart < endTime) {
    const body = {
      type: "candleSnapshot",
      req: { coin, interval, startTime: currentStart, endTime },
    };

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HL API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{
      t: number; T: number; s: string; i: string;
      o: string; c: string; h: string; l: string; v: string; n: number;
    }>;

    if (data.length === 0) break;

    for (const raw of data) {
      allCandles.push({
        t: raw.t,
        o: parseFloat(raw.o),
        h: parseFloat(raw.h),
        l: parseFloat(raw.l),
        c: parseFloat(raw.c),
        v: parseFloat(raw.v),
        n: raw.n,
      });
    }

    const lastTs = data[data.length - 1].t;
    if (lastTs <= currentStart) break;
    currentStart = lastTs + 1;

    if (data.length >= limit) {
      await sleep(delay);
    } else {
      break;
    }
  }

  const seen = new Set<number>();
  return allCandles.filter((c) => {
    if (seen.has(c.t)) return false;
    seen.add(c.t);
    return true;
  });
}

// ── Coinbase Perpetual (Advanced Trade API) ────────────────────────

const CB_PERP_BASE = "https://api.coinbase.com/api/v3/brokerage/market";
const CB_PERP_MAX_CANDLES = 300;

function toCoinbasePerpGranularity(interval: CandleInterval): string {
  const map: Record<string, string> = {
    "1m": "ONE_MINUTE", "5m": "FIVE_MINUTE", "15m": "FIFTEEN_MINUTE",
    "30m": "THIRTY_MINUTE", "1h": "ONE_HOUR", "2h": "TWO_HOUR",
    "1d": "ONE_DAY",
  };
  const g = map[interval];
  if (!g) throw new Error(`Coinbase perp does not support interval: ${interval}`);
  return g;
}

function intervalToMsLocal(interval: CandleInterval): number {
  const map: Record<string, number> = {
    "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "1d": 86_400_000,
  };
  return map[interval] ?? 900_000;
}

async function fetchCoinbasePerp(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
  options: CandleClientOptions,
): Promise<Candle[]> {
  const baseUrl = options.baseUrl ?? CB_PERP_BASE;
  const delay = options.requestDelayMs ?? 350;
  const productId = options.coinbasePerpProductId ?? `${coin}-PERP-INTX`;
  const granularity = toCoinbasePerpGranularity(interval);
  const intervalMs = intervalToMsLocal(interval);
  const maxCandles = options.candlesPerRequest ?? CB_PERP_MAX_CANDLES;
  const windowMs = maxCandles * intervalMs;

  const allCandles: Candle[] = [];
  let currentStart = startTime;

  while (currentStart < endTime) {
    const batchEnd = Math.min(currentStart + windowMs, endTime);
    const startSec = Math.floor(currentStart / 1000);
    const endSec = Math.floor(batchEnd / 1000);

    const url =
      `${baseUrl}/products/${productId}/candles` +
      `?granularity=${granularity}&start=${startSec}&end=${endSec}`;

    const response = await fetchWithRetry(url, undefined, "Coinbase perp");
    const json = (await response.json()) as {
      candles: Array<{ start: string; low: string; high: string; open: string; close: string; volume: string }>;
    };

    const data = json.candles ?? [];

    if (data.length === 0) {
      currentStart = batchEnd;
      continue;
    }

    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      allCandles.push({
        t: parseInt(row.start) * 1000,
        o: parseFloat(row.open),
        h: parseFloat(row.high),
        l: parseFloat(row.low),
        c: parseFloat(row.close),
        v: parseFloat(row.volume),
        n: 0,
      });
    }

    currentStart = batchEnd;

    if (data.length >= maxCandles) {
      await sleep(delay);
    }
  }

  return deduplicateCandles(allCandles);
}

// ── Coinbase Spot (Exchange API) ────────────────────────────────────

const CB_BASE = "https://api.exchange.coinbase.com";
const CB_LIMIT = 300;

function toCoinbaseGranularity(interval: CandleInterval): number {
  const map: Record<string, number> = {
    "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400,
  };
  const g = map[interval];
  if (!g) throw new Error(`Coinbase does not support interval: ${interval}`);
  return g;
}

async function fetchCoinbase(
  coin: string,
  interval: CandleInterval,
  startTime: number,
  endTime: number,
  options: CandleClientOptions,
): Promise<Candle[]> {
  const baseUrl = options.baseUrl ?? CB_BASE;
  const limit = options.candlesPerRequest ?? CB_LIMIT;
  const delay = options.requestDelayMs ?? 350;
  const productId = options.coinbaseProductId ?? `${coin}-USD`;
  const granularity = toCoinbaseGranularity(interval);
  const granularityMs = granularity * 1000;

  const allCandles: Candle[] = [];
  let currentStart = startTime;

  while (currentStart < endTime) {
    const batchEnd = Math.min(currentStart + limit * granularityMs, endTime);
    const startISO = new Date(currentStart).toISOString();
    const endISO = new Date(batchEnd).toISOString();

    const url =
      `${baseUrl}/products/${productId}/candles` +
      `?start=${startISO}&end=${endISO}&granularity=${granularity}`;

    const response = await fetchWithRetry(url, undefined, "Coinbase");
    const data = (await response.json()) as number[][];

    if (data.length === 0) {
      currentStart = batchEnd;
      continue;
    }

    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      allCandles.push({
        t: row[0] * 1000,
        o: row[3],
        h: row[2],
        l: row[1],
        c: row[4],
        v: row[5],
        n: 0,
      });
    }

    currentStart = batchEnd;

    if (data.length >= limit) {
      await sleep(delay);
    }
  }

  return deduplicateCandles(allCandles);
}
