import express from "express";
import rateLimit from "express-rate-limit";
import type { ExchangeConfig } from "./types/config.js";
import type { SqliteStore } from "./adapters/sqlite-store.js";
import type { PositionBook } from "./domain/position-book.js";
import type { HlClient } from "./types/hl-client.js";
import { handleSignal, type SignalHandlerDeps } from "./application/handle-signal.js";
import { replayStrategy } from "./application/replay-strategy.js";
import type { CandleStreamer } from "./adapters/candle-streamer.js";
import type { StrategyRunner } from "./application/strategy-runner.js";
import { intervalToMs, atr, type Strategy, type CandleInterval, type CandleCache } from "@breaker/backtest";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const SignalPayloadSchema = z.object({
  coin: z.string().min(1),
  direction: z.enum(["long", "short"]),
  entryPrice: z.number().positive().nullable(),
  stopLoss: z.number().positive(),
  takeProfits: z.array(z.object({
    price: z.number().positive(),
    pctOfPosition: z.number().min(0).max(1),
  })).default([]),
  comment: z.string().default(""),
  alertId: z.string().optional(),
});

export interface ServerDeps {
  config: ExchangeConfig;
  store: SqliteStore;
  positionBook: PositionBook;
  hlClient: HlClient;
  walletAddress: string;
  signalHandlerDeps: SignalHandlerDeps;
  streamers: Map<string, CandleStreamer>;
  candleCache?: CandleCache;
  strategyFactory: (name: string) => Strategy;
  runners: StrategyRunner[];
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Rate limit POST endpoints: 10 req/min per IP
  const postLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: false, legacyHeaders: false }) as unknown as express.RequestHandler;

  // Pre-compute O(1) lookup maps (computed once per createApp call)
  const coinConfigMap = new Map(deps.config.coins.map((c) => [c.coin, c]));
  const coinStreamerMap = new Map<string, CandleStreamer>();
  for (const [key, streamer] of deps.streamers) {
    const coin = key.split(":")[0];
    if (!coinStreamerMap.has(coin)) coinStreamerMap.set(coin, streamer);
  }

  function findCoinConfig(coin: string) {
    return coinConfigMap.get(coin) ?? null;
  }

  function findStreamerForCoin(coin: string): CandleStreamer | null {
    return coinStreamerMap.get(coin) ?? null;
  }

  app.get("/health", (_req, res) => {
    const streamerStatuses = Array.from(deps.streamers.entries()).map(([key, streamer]) => {
      const [coin, interval] = key.split(":");
      const latestCandle = streamer.getLatest();
      const lastCandleAt = latestCandle?.t ?? null;
      const ivlMs = intervalToMs(interval as CandleInterval);
      const candleStale = lastCandleAt != null && (Date.now() - lastCandleAt) > 5 * ivlMs;
      return { coin, interval, lastCandleAt, status: candleStale ? "stale" as const : "ok" as const };
    });

    const anyStale = streamerStatuses.some((s) => s.status === "stale");

    res.json({
      status: anyStale ? "stale" : "ok",
      streamers: streamerStatuses,
      mode: deps.config.mode,
      coins: deps.config.coins.map((c) => c.coin),
      uptime: process.uptime(),
    });
  });

  app.get("/positions", (_req, res) => {
    const positions = deps.positionBook.getAll();
    res.json({ positions });
  });

  app.get("/orders", (_req, res) => {
    const orders = deps.store.getRecentOrders(100);
    res.json({ orders });
  });

  app.get("/equity", (_req, res) => {
    const snapshots = deps.store.getEquitySnapshots(500);
    res.json({ snapshots });
  });

  app.get("/open-orders", async (_req, res) => {
    try {
      const orders = await deps.hlClient.getOpenOrders(deps.walletAddress);
      res.json({ orders });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/candles", async (req, res) => {
    try {
      const coin = (req.query.coin as string) || deps.config.coins[0]?.coin;
      const interval = (req.query.interval as string) || deps.config.coins[0]?.strategies[0]?.interval;
      if (!coin || !interval) {
        res.status(400).json({ error: "coin and interval required" });
        return;
      }

      const candles = await fetchCandlesForReplay(coin, interval as CandleInterval, Date.now(), REPLAY_WARMUP);
      res.json({ candles });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/signals", (_req, res) => {
    const signals = deps.store.getRecentSignals(100);
    res.json({ signals });
  });

  // Replay warmup: strategies with daily indicators (e.g. EMA 50 on 1d)
  // need ~51 daily candles of warmup before signals can generate.
  // 15000 × 15m ≈ 156 days → daily EMA valid from day 51 → ~106 days of signal coverage.
  const REPLAY_WARMUP = 15000;

  /** Fetch candles using SQLite cache (sync → read) or streamer fallback. */
  async function fetchCandlesForReplay(coin: string, interval: CandleInterval, endTime: number, bars: number) {
    const ivlMs = intervalToMs(interval);
    const startTime = endTime - bars * ivlMs;

    if (deps.candleCache) {
      await deps.candleCache.sync(
        coin,
        interval,
        startTime,
        endTime,
        { source: deps.config.dataSource },
      );
      return deps.candleCache.getCandles(
        coin,
        interval,
        startTime,
        endTime,
        deps.config.dataSource,
      );
    }

    const streamer = deps.streamers.get(`${coin}:${interval}`);
    if (streamer) return streamer.fetchHistorical(endTime, bars);

    return [];
  }

  // TTL cache per coin:interval
  const replayCache = new Map<string, { cachedAt: number; signals: ReturnType<typeof replayStrategy> }>();

  app.get("/strategy-signals", async (req, res) => {
    const now = Date.now();

    try {
      const coin = (req.query.coin as string) || deps.config.coins[0]?.coin;
      const strategyName = (req.query.strategy as string) || deps.config.coins[0]?.strategies[0]?.name;
      const coinCfg = findCoinConfig(coin);
      if (!coinCfg) {
        res.status(400).json({ error: `Unknown coin: ${coin}` });
        return;
      }
      const stratCfg = coinCfg.strategies.find((s) => s.name === strategyName) ?? coinCfg.strategies[0];
      const interval = stratCfg.interval as CandleInterval;
      const cacheKey = `${coin}:${stratCfg.name}:${interval}`;
      const cacheTtlMs = intervalToMs(interval);

      const cached = replayCache.get(cacheKey);
      if (cached && (now - cached.cachedAt) < cacheTtlMs) {
        res.json({ signals: cached.signals });
        return;
      }

      const candles = await fetchCandlesForReplay(coin, interval, now, REPLAY_WARMUP);
      const signals = replayStrategy({
        strategyFactory: () => deps.strategyFactory(stratCfg.name),
        candles,
        interval,
      });
      replayCache.set(cacheKey, { cachedAt: now, signals });
      res.json({ signals });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/account", async (_req, res) => {
    try {
      const state = await deps.hlClient.getAccountState(deps.walletAddress);
      res.json({
        walletAddress: deps.walletAddress,
        ...state,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/config", (_req, res) => {
    const { mode, coins, guardrails, sizing, dataSource } = deps.config;
    res.json({ mode, coins, guardrails, sizing, dataSource });
  });

  const AutoTradingSchema = z.object({
    coin: z.string().min(1),
    strategy: z.string().min(1).optional(),
    enabled: z.boolean(),
  });

  app.post("/auto-trading", postLimiter, (req, res) => {
    const parsed = AutoTradingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }

    const { coin, strategy: stratName, enabled } = parsed.data;
    const coinCfg = findCoinConfig(coin);
    if (!coinCfg) {
      res.status(400).json({ error: `Unknown coin: ${coin}` });
      return;
    }

    // Toggle per-strategy or all strategies for the coin
    const targets = stratName
      ? coinCfg.strategies.filter((s) => s.name === stratName)
      : coinCfg.strategies;

    if (targets.length === 0) {
      res.status(400).json({ error: `Strategy ${stratName} not found for ${coin}` });
      return;
    }

    for (const strat of targets) {
      strat.autoTradingEnabled = enabled;
    }

    // Propagate to runner instances so the change takes effect immediately
    for (const runner of deps.runners) {
      if (runner.getCoin() !== coin) continue;
      if (stratName && runner.getStrategyName() !== stratName) continue;
      runner.setAutoTradingEnabled(enabled);
    }

    res.json({ coin, autoTradingEnabled: enabled });
  });

  app.post("/signal", postLimiter, async (req, res) => {
    const parsed = SignalPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid signal payload", details: parsed.error.issues });
      return;
    }

    const { coin, direction, entryPrice, stopLoss, takeProfits, comment, alertId } = parsed.data;
    const coinCfg = findCoinConfig(coin);
    if (!coinCfg) {
      res.status(400).json({ error: `Unknown coin: ${coin}` });
      return;
    }

    // Use market price from streamer; fall back to entryPrice
    const streamer = findStreamerForCoin(coin);
    const latestCandle = streamer?.getLatest();
    const currentPrice = latestCandle?.c ?? entryPrice;
    if (currentPrice == null || currentPrice <= 0) {
      res.status(422).json({ status: "rejected", reason: "No market price available and entryPrice is null" });
      return;
    }

    try {
      const result = await handleSignal(
        {
          signal: { direction, entryPrice, stopLoss, takeProfits, comment },
          currentPrice,
          source: "api",
          alertId,
          coin,
          leverage: coinCfg.leverage,
          autoTradingEnabled: true, // API signals always allowed
        },
        deps.signalHandlerDeps,
      );

      if (result.success) {
        res.json({ status: "executed", signalId: result.signalId });
      } else {
        res.status(422).json({ status: "rejected", signalId: result.signalId, reason: result.reason });
      }
    } catch (err) {
      res.status(500).json({ status: "error", error: (err as Error).message });
    }
  });

  const ClosePositionSchema = z.object({
    coin: z.string().min(1),
  });

  const closingInProgress = new Set<string>();

  app.post("/close-position", postLimiter, async (req, res) => {
    const parsed = ClosePositionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }

    const { coin } = parsed.data;

    if (closingInProgress.has(coin)) {
      res.status(409).json({ error: `Close already in progress for ${coin}` });
      return;
    }

    const position = deps.positionBook.get(coin);
    if (!position) {
      res.status(400).json({ error: `No open position for ${coin}` });
      return;
    }

    closingInProgress.add(position.coin);
    try {
      // Market order on opposite side to close
      const isBuy = position.direction === "short";
      await deps.hlClient.placeMarketOrder(position.coin, isBuy, position.size);

      deps.positionBook.close(position.coin);

      // Cancel all open orders for this coin
      const openOrders = await deps.hlClient.getOpenOrders(deps.walletAddress);
      const coinOrders = openOrders.filter((o) => o.coin === coin);
      for (const o of coinOrders) {
        await deps.hlClient.cancelOrder(coin, o.oid);
      }

      deps.signalHandlerDeps.onSignalProcessed?.();
      res.json({ status: "closed" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      closingInProgress.delete(position.coin);
    }
  });

  app.delete("/open-order/:oid", async (req, res) => {
    const oid = Number(req.params.oid);
    if (!Number.isFinite(oid)) {
      res.status(400).json({ error: "Invalid order ID" });
      return;
    }

    try {
      const openOrders = await deps.hlClient.getOpenOrders(deps.walletAddress);
      const order = openOrders.find((o) => o.oid === oid);
      if (!order) {
        res.status(404).json({ error: `Order ${oid} not found` });
        return;
      }

      await deps.hlClient.cancelOrder(order.coin, oid);
      deps.signalHandlerDeps.onSignalProcessed?.();
      res.json({ status: "cancelled" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const QuickSignalSchema = z.object({
    coin: z.string().min(1),
    direction: z.enum(["long", "short"]),
  });

  app.post("/quick-signal", postLimiter, async (req, res) => {
    const parsed = QuickSignalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }

    const { coin, direction } = parsed.data;
    const coinCfg = findCoinConfig(coin);
    if (!coinCfg) {
      res.status(400).json({ error: `Unknown coin: ${coin}` });
      return;
    }

    const streamer = findStreamerForCoin(coin);
    if (!streamer) {
      res.status(400).json({ error: `No streamer for ${coin}` });
      return;
    }

    const candles = streamer.getCandles();
    if (candles.length < 20) {
      res.status(422).json({ status: "rejected", reason: "Not enough candles for ATR" });
      return;
    }

    const lastCandle = candles[candles.length - 1];
    const price = lastCandle.c;

    // Compute SL from ATR using strategy params (same logic as the strategy)
    const stratName = coinCfg.strategies[0]?.name ?? "donchian-adx";
    const strategy = deps.strategyFactory(stratName);
    const atrLen = strategy.params.atrLen?.value ?? strategy.params.atrStopMult ? 14 : 14;
    const atrMult = strategy.params.atrStopMult?.value ?? 2.0;
    const atrValues = atr(candles, atrLen);
    const lastAtr = atrValues[atrValues.length - 1];

    if (!lastAtr || isNaN(lastAtr)) {
      res.status(422).json({ status: "rejected", reason: "ATR not available" });
      return;
    }

    const stopDist = atrMult * lastAtr;
    const stopLoss = direction === "long" ? price - stopDist : price + stopDist;

    const signal = {
      direction,
      entryPrice: null as number | null,
      stopLoss,
      takeProfits: [] as { price: number; pctOfPosition: number }[],
      comment: "Manual from dashboard",
    };

    const alertId = `manual-${randomUUID()}`;

    try {
      const result = await handleSignal(
        {
          signal,
          currentPrice: price,
          source: "api",
          alertId,
          coin,
          leverage: coinCfg.leverage,
          autoTradingEnabled: true, // Manual signals always allowed
        },
        deps.signalHandlerDeps,
      );

      if (result.success) {
        res.json({ status: "executed", signalId: result.signalId, stopLoss: Math.round(stopLoss * 100) / 100 });
      } else {
        res.status(422).json({ status: "rejected", signalId: result.signalId, reason: result.reason });
      }
    } catch (err) {
      res.status(500).json({ status: "error", error: (err as Error).message });
    }
  });

  return app;
}
