import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hyperliquid } from "hyperliquid";
import { isMainModule } from "@breaker/kit";
import { createDonchianAdx, createKeltnerRsi2 } from "@breaker/backtest";
import { ExchangeConfigSchema, type ExchangeConfig } from "./types/config.js";
import { loadEnv } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { SqliteStore } from "./adapters/sqlite-store.js";
import { EventLog } from "./adapters/event-log.js";
import { HyperliquidClient } from "./adapters/hyperliquid-client.js";
import { HlEventStream, type WsOrder, type WsUserFill } from "./adapters/hl-event-stream.js";
import { CandlePoller } from "./adapters/candle-poller.js";
import { HttpAlertsClient } from "./adapters/alerts-client.js";
import { PositionBook } from "./domain/position-book.js";
import { StrategyRunner } from "./application/strategy-runner.js";
import { ReconcileLoop } from "./application/reconcile-loop.js";
import { createApp } from "./server.js";
import { WsBroker } from "./lib/ws-broker.js";
import type { SignalHandlerDeps } from "./application/signal-handler.js";
import type WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(): ExchangeConfig {
  const configPath = join(__dirname, "../exchange-config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return ExchangeConfigSchema.parse(raw);
}

function createStrategy(name: string) {
  switch (name) {
    case "donchian-adx":
      return createDonchianAdx();
    case "keltner-rsi2":
      return createKeltnerRsi2();
    default:
      throw new Error(`Unknown strategy: ${name}`);
  }
}

async function main() {
  const config = loadConfig();
  const env = loadEnv(config.mode);
  logger.info({ mode: config.mode, asset: config.asset, strategy: config.strategy }, "Starting exchange daemon");

  // Initialize adapters
  const dataDir = join(__dirname, "../data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "exchange.db");
  const store = new SqliteStore(dbPath);
  const eventLog = new EventLog(join(dataDir, "events.ndjson"));
  const sdk = new Hyperliquid({ privateKey: env.HL_PRIVATE_KEY, testnet: config.mode === "testnet" });
  await sdk.connect();
  logger.info("Connected to Hyperliquid");

  const hlClient = new HyperliquidClient(sdk);
  const eventStream = new HlEventStream(sdk, env.HL_ACCOUNT_ADDRESS);
  const alertsClient = new HttpAlertsClient(config.gatewayUrl);
  const positionBook = new PositionBook();

  // Load asset metadata (szDecimals for size rounding)
  await hlClient.loadSzDecimals(config.asset);

  // Set leverage before any trading
  await hlClient.setLeverage(config.asset, config.leverage, config.marginType === "cross");
  logger.info({ asset: config.asset, leverage: config.leverage }, "Leverage set");

  await eventLog.append({
    type: "leverage_set",
    timestamp: new Date().toISOString(),
    data: { asset: config.asset, leverage: config.leverage },
  });

  // WebSocket broker
  const wsBroker = new WsBroker();

  // Create shared deps
  const signalHandlerDeps: SignalHandlerDeps = {
    config,
    hlClient,
    store,
    eventLog,
    alertsClient,
    positionBook,
    onSignalProcessed: () => {
      // Push immediate update after signal execution
      wsBroker.broadcastEvent("positions", positionBook.getAll());
      wsBroker.broadcastEvent("orders", store.getRecentOrders(100));
      // Fetch fresh open orders from HL (SL/TP just placed)
      // Small delay: HL needs a moment to register the new orders
      setTimeout(() => {
        hlClient.getOpenOrders(env.HL_ACCOUNT_ADDRESS).then((oo) => {
          wsBroker.broadcastEvent("open-orders", oo);
        }).catch(() => {});
      }, 1500);
    },
  };

  // Initialize strategy and candle poller
  const strategy = createStrategy(config.strategy);
  const poller = new CandlePoller({
    coin: config.asset,
    interval: config.interval,
    dataSource: config.dataSource,
  });

  // Strategy runner
  const runner = new StrategyRunner({
    config,
    strategy,
    poller,
    positionBook,
    signalHandlerDeps,
    eventLog,
    onNewCandle: (candle) => {
      wsBroker.broadcastEvent("candle", candle);
    },
  });

  // Reconcile loop (created before warmup — needs store dep for order sync)
  const reconciler = new ReconcileLoop({
    hlClient,
    positionBook,
    eventLog,
    store,
    walletAddress: env.HL_ACCOUNT_ADDRESS,
    intervalMs: 300_000,
    onReconciled: (data) => {
      wsBroker.broadcastEvent("positions", data.positions);
      wsBroker.broadcastEvent("orders", data.orders);
      wsBroker.broadcastEvent("open-orders", data.openOrders);
      wsBroker.broadcastEvent("equity", store.getEquitySnapshots(500));
    },
  });

  // Startup sync: hydrate positions from HL + sync order statuses
  logger.info("Running startup reconciliation...");
  const startupResult = await reconciler.check();
  if (startupResult.actions.length > 0) {
    logger.info({ actions: startupResult.actions }, "Startup corrections applied");
  }

  // Warmup
  logger.info({ bars: config.warmupBars }, "Starting warmup...");
  await runner.warmup();
  logger.info("Warmup complete");

  // Express server
  const app = createApp({
    config,
    store,
    positionBook,
    hlClient,
    walletAddress: env.HL_ACCOUNT_ADDRESS,
    signalHandlerDeps,
    candlePoller: poller,
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "Exchange server listening");
  });

  // Attach WebSocket to same HTTP server
  wsBroker.attach(server);
  wsBroker.on("client:connected", async (ws: WebSocket) => {
    // Send full snapshot on connect
    const snapshot = {
      positions: positionBook.getAll(),
      orders: store.getRecentOrders(100),
      openOrders: await hlClient.getOpenOrders(env.HL_ACCOUNT_ADDRESS).catch(() => []),
      equity: store.getEquitySnapshots(500),
      health: { status: "ok", mode: config.mode, asset: config.asset, strategy: config.strategy, uptime: process.uptime() },
      candles: poller.getCandles(),
      signals: store.getRecentSignals(100),
    };
    ws.send(JSON.stringify({ type: "snapshot", timestamp: new Date().toISOString(), data: snapshot }));
  });
  logger.info("WebSocket broker attached on /ws");

  await eventLog.append({
    type: "daemon_started",
    timestamp: new Date().toISOString(),
    data: { mode: config.mode, asset: config.asset, strategy: config.strategy },
  });

  // Helper: sync PositionBook from HL and broadcast full state
  const syncAndBroadcast = async () => {
    const [hlPositions, openOrders] = await Promise.all([
      hlClient.getPositions(env.HL_ACCOUNT_ADDRESS),
      hlClient.getOpenOrders(env.HL_ACCOUNT_ADDRESS),
    ]);

    // Sync PositionBook with HL truth
    const hlCoins = new Set(hlPositions.map((p) => p.coin));
    for (const local of positionBook.getAll()) {
      if (!hlCoins.has(local.coin)) {
        positionBook.close(local.coin);
        logger.info({ coin: local.coin }, "Position closed (WS event)");
      }
    }
    for (const hlPos of hlPositions) {
      if (!positionBook.get(hlPos.coin)) {
        positionBook.open({
          coin: hlPos.coin,
          direction: hlPos.direction,
          entryPrice: hlPos.entryPrice,
          size: hlPos.size,
          stopLoss: 0,
          takeProfits: [],
          openedAt: new Date().toISOString(),
          signalId: -1,
        });
      }
    }

    // Sync order statuses: pending orders no longer on HL open list → resolved
    const openOidSet = new Set(openOrders.map((o) => o.oid));
    const pendingOrders = store.getPendingOrders().filter(
      (o) => o.hl_order_id != null && !Number.isNaN(Number(o.hl_order_id)),
    );
    const resolvedOrders = pendingOrders.filter(
      (o) => !openOidSet.has(Number(o.hl_order_id)),
    );

    if (resolvedOrders.length > 0) {
      const historicalOrders = await hlClient.getHistoricalOrders(env.HL_ACCOUNT_ADDRESS);
      const historicalMap = new Map(historicalOrders.map((o) => [o.oid, o.status]));

      for (const order of resolvedOrders) {
        const oid = Number(order.hl_order_id);
        const hlStatus = historicalMap.get(oid);
        if (hlStatus === "filled" || hlStatus === "triggered") {
          store.updateOrderStatus(order.id!, "filled", new Date().toISOString());
          logger.info({ oid: order.hl_order_id, tag: order.tag }, "Order filled (sync)");
        } else if (hlStatus === "canceled" || hlStatus === "marginCanceled") {
          store.updateOrderStatus(order.id!, "cancelled");
          logger.info({ oid: order.hl_order_id, tag: order.tag }, "Order cancelled (sync)");
        } else if (hlStatus === "rejected") {
          store.updateOrderStatus(order.id!, "rejected");
          logger.info({ oid: order.hl_order_id, tag: order.tag }, "Order rejected (sync)");
        } else {
          // Not in open orders, not in historical — if no position exists, mark cancelled
          const positionExists = positionBook.get(order.coin) != null;
          if (!positionExists) {
            store.updateOrderStatus(order.id!, "cancelled");
            logger.info({ oid: order.hl_order_id, tag: order.tag }, "Order cancelled (no position, sync)");
          }
        }
      }
    }

    wsBroker.broadcastEvent("positions", positionBook.getAll());
    wsBroker.broadcastEvent("orders", store.getRecentOrders(100));
    wsBroker.broadcastEvent("open-orders", openOrders);
  };

  // Hyperliquid event stream (real-time push via WebSocket)
  await eventStream.start({
    onOrderUpdate: (orders: WsOrder[]) => {
      for (const wsOrder of orders) {
        const oid = String(wsOrder.order.oid);
        const localOrder = store.getOrderByHlOid(oid);
        if (!localOrder || !localOrder.id) continue;

        const status = wsOrder.status;
        if (status === "filled" || status === "triggered") {
          store.updateOrderStatus(localOrder.id, "filled", new Date(wsOrder.statusTimestamp).toISOString());
          logger.info({ oid, tag: localOrder.tag, status }, "Order filled (WS push)");
        } else if (status === "canceled" || status === "marginCanceled") {
          store.updateOrderStatus(localOrder.id, "cancelled");
          logger.info({ oid, tag: localOrder.tag, status }, "Order cancelled (WS push)");
        } else if (status === "rejected") {
          store.updateOrderStatus(localOrder.id, "rejected");
          logger.info({ oid, tag: localOrder.tag, status }, "Order rejected (WS push)");
        }
      }

      // Always re-sync positions from HL and broadcast
      syncAndBroadcast().catch(() => {});
    },

    onFill: (fills: WsUserFill[], isSnapshot: boolean) => {
      if (isSnapshot) return;
      syncAndBroadcast().catch(() => {});
    },
  });
  logger.info("Subscribed to HL order updates and user fills");

  // Start loops
  runner.start();
  reconciler.start();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    runner.stop();
    reconciler.stop();
    eventStream.stop();
    wsBroker.close();

    await eventLog.append({
      type: "daemon_stopped",
      timestamp: new Date().toISOString(),
      data: {},
    });

    server.close();
    store.close();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    logger.error(err, "Fatal error");
    process.exit(1);
  });
}
