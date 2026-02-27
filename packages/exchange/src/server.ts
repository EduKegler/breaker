import express from "express";
import rateLimit from "express-rate-limit";
import type { ExchangeConfig } from "./types/config.js";
import type { SqliteStore } from "./adapters/sqlite-store.js";
import type { PositionBook } from "./domain/position-book.js";
import type { HlClient } from "./adapters/hyperliquid-client.js";
import { handleSignal, type SignalHandlerDeps } from "./application/signal-handler.js";
import { replayStrategy } from "./application/strategy-replay.js";
import type { CandlePoller } from "./adapters/candle-poller.js";
import { intervalToMs, atr, type Strategy, type CandleInterval } from "@breaker/backtest";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const SignalPayloadSchema = z.object({
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
  candlePoller: CandlePoller;
  strategyFactory: () => Strategy;
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // Rate limit POST endpoints: 10 req/min per IP
  const postLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: false, legacyHeaders: false }) as unknown as express.RequestHandler;

  app.get("/health", (_req, res) => {
    const latestCandle = deps.candlePoller.getLatest();
    const lastCandleAt = latestCandle?.t ?? null;
    const ivlMs = intervalToMs(deps.config.interval as CandleInterval);
    const candleStale = lastCandleAt != null && (Date.now() - lastCandleAt) > 5 * ivlMs;

    res.json({
      status: candleStale ? "stale" : "ok",
      lastCandleAt,
      mode: deps.config.mode,
      asset: deps.config.asset,
      strategy: deps.config.strategy,
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
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 200;

    if (before) {
      try {
        const candles = await deps.candlePoller.fetchHistorical(before, limit);
        res.json({ candles });
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    } else {
      const candles = deps.candlePoller.getCandles();
      res.json({ candles });
    }
  });

  app.get("/signals", (_req, res) => {
    const signals = deps.store.getRecentSignals(100);
    res.json({ signals });
  });

  // Replay warmup: strategies with daily indicators (e.g. EMA 50 on 1d)
  // need ~51 daily candles = ~5000 x 15m candles for valid signals
  const REPLAY_WARMUP = 5000;

  // Cache with TTL: replay is deterministic, only re-fetch once per candle interval
  let replayCache: { cachedAt: number; signals: ReturnType<typeof replayStrategy> } | null = null;
  const replayCacheTtlMs = intervalToMs(deps.config.interval as CandleInterval);

  // Separate cache for ?before= requests (keyed by before timestamp)
  const beforeCache = new Map<number, { cachedAt: number; signals: ReturnType<typeof replayStrategy> }>();

  app.get("/strategy-signals", async (req, res) => {
    const before = req.query.before ? Number(req.query.before) : undefined;
    const now = Date.now();

    try {
      if (before) {
        // Historical requests: cache indefinitely (historical data doesn't change)
        const cached = beforeCache.get(before);
        if (cached) {
          res.json({ signals: cached.signals });
          return;
        }

        const candles = await deps.candlePoller.fetchHistorical(before, REPLAY_WARMUP);
        const signals = replayStrategy({
          strategyFactory: deps.strategyFactory,
          candles,
          interval: deps.config.interval as CandleInterval,
        });
        beforeCache.set(before, { cachedAt: now, signals });
        res.json({ signals });
        return;
      }

      // No-before: use TTL cache (one candle interval)
      if (replayCache && (now - replayCache.cachedAt) < replayCacheTtlMs) {
        res.json({ signals: replayCache.signals });
        return;
      }

      const candles = await deps.candlePoller.fetchHistorical(now, REPLAY_WARMUP);
      const signals = replayStrategy({
        strategyFactory: deps.strategyFactory,
        candles,
        interval: deps.config.interval as CandleInterval,
      });
      replayCache = { cachedAt: now, signals };
      res.json({ signals });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/config", (_req, res) => {
    const { mode, asset, strategy, interval, leverage, guardrails, sizing, dataSource } = deps.config;
    res.json({ mode, asset, strategy, interval, leverage, guardrails, sizing, dataSource });
  });

  app.post("/signal", postLimiter, async (req, res) => {
    const parsed = SignalPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid signal payload", details: parsed.error.issues });
      return;
    }

    const { direction, entryPrice, stopLoss, takeProfits, comment, alertId } = parsed.data;

    // Use market price from poller; fall back to entryPrice only if poller has data
    const latestCandle = deps.candlePoller.getLatest();
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

    closingInProgress.add(coin);
    try {
      // Market order on opposite side to close
      const isBuy = position.direction === "short";
      await deps.hlClient.placeMarketOrder(coin, isBuy, position.size);

      deps.positionBook.close(coin);

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
      closingInProgress.delete(coin);
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
    direction: z.enum(["long", "short"]),
  });

  app.post("/quick-signal", postLimiter, async (req, res) => {
    const parsed = QuickSignalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", details: parsed.error.issues });
      return;
    }

    const { direction } = parsed.data;
    const candles = deps.candlePoller.getCandles();
    if (candles.length < 20) {
      res.status(422).json({ status: "rejected", reason: "Not enough candles for ATR" });
      return;
    }

    const lastCandle = candles[candles.length - 1];
    const price = lastCandle.c;

    // Compute SL from ATR using strategy params (same logic as the strategy)
    const strategy = deps.strategyFactory();
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
        { signal, currentPrice: price, source: "api", alertId },
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
