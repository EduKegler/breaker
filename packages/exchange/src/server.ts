import express from "express";
import type { ExchangeConfig } from "./types/config.js";
import type { SqliteStore } from "./adapters/sqlite-store.js";
import type { PositionBook } from "./domain/position-book.js";
import type { HlClient } from "./adapters/hyperliquid-client.js";
import { handleSignal, type SignalHandlerDeps } from "./application/signal-handler.js";
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
  signalHandlerDeps: SignalHandlerDeps;
}

export function createApp(deps: ServerDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
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

  app.get("/config", (_req, res) => {
    const { mode, asset, strategy, interval, leverage, guardrails, sizing } = deps.config;
    res.json({ mode, asset, strategy, interval, leverage, guardrails, sizing });
  });

  app.post("/signal", async (req, res) => {
    const parsed = SignalPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid signal payload", details: parsed.error.issues });
      return;
    }

    const { direction, entryPrice, stopLoss, takeProfits, comment, alertId } = parsed.data;
    const currentPrice = entryPrice ?? 0; // Will be resolved if null

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

  return app;
}
