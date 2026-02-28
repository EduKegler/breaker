import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hyperliquid } from "hyperliquid";
import { isMainModule } from "@breaker/kit";
import { createDonchianAdx, createKeltnerRsi2 } from "@breaker/backtest";
import { ExchangeConfigSchema, type ExchangeConfig } from "./types/config.js";
import { loadEnv } from "./lib/load-env.js";
import { logger } from "./lib/logger.js";
import { SqliteStore } from "./adapters/sqlite-store.js";
import { EventLog } from "./adapters/event-log.js";
import { HyperliquidClient } from "./adapters/hyperliquid-client.js";
import { DryRunHlClient } from "./adapters/dry-run-client.js";
import { HlEventStream } from "./adapters/hl-event-stream.js";
import type { WsOrder, WsUserFill } from "./types/hl-event-stream.js";
import { CandleStreamer } from "./adapters/candle-streamer.js";
import { CandleCache } from "@breaker/backtest";
import { HttpAlertsClient } from "./adapters/alerts-client.js";
import { PositionBook } from "./domain/position-book.js";
import { resolveOrderStatus } from "./domain/order-status.js";
import { StrategyRunner } from "./application/strategy-runner.js";
import { ReconcileLoop } from "./application/reconcile-loop.js";
import { createApp } from "./create-app.js";
import { WsBroker } from "./lib/ws-broker.js";
import type { HlClient } from "./types/hl-client.js";
import type { SignalHandlerDeps } from "./application/handle-signal.js";
import type WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = logger.createChild("daemon");

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

async function syncPositionsAndBroadcast(deps: {
  hlClient: HlClient;
  positionBook: PositionBook;
  store: SqliteStore;
  walletAddress: string;
  wsBroker: WsBroker;
}): Promise<void> {
  const { hlClient, positionBook, store, walletAddress, wsBroker } = deps;
  const [hlPositions, openOrders] = await Promise.all([
    hlClient.getPositions(walletAddress),
    hlClient.getOpenOrders(walletAddress),
  ]);

  // Sync PositionBook with HL truth
  const hlCoins = new Set(hlPositions.map((p) => p.coin));
  for (const local of positionBook.getAll()) {
    if (!hlCoins.has(local.coin)) {
      positionBook.close(local.coin);
      log.info({ coin: local.coin }, "Position closed (WS event)");
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
    const historicalOrders = await hlClient.getHistoricalOrders(walletAddress);
    const historicalMap = new Map(historicalOrders.map((o) => [o.oid, o.status]));

    for (const order of resolvedOrders) {
      const oid = Number(order.hl_order_id);
      const hlStatus = historicalMap.get(oid);
      const positionExists = positionBook.get(order.coin) != null;
      const newStatus = resolveOrderStatus(hlStatus, positionExists);
      if (!newStatus) continue;

      const filledAt = newStatus === "filled" ? new Date().toISOString() : undefined;
      store.updateOrderStatus(order.id!, newStatus, filledAt);
      log.info({ oid: order.hl_order_id, tag: order.tag, newStatus }, `Order ${newStatus} (sync)`);
    }
  }

  wsBroker.broadcastEvent("positions", positionBook.getAll());
  wsBroker.broadcastEvent("orders", store.getRecentOrders(100));
  wsBroker.broadcastEvent("open-orders", openOrders);
}

async function main() {
  const config = loadConfig();

  // Apply per-module log levels before any child loggers are used
  logger.setLogConfig(config.logLevels);

  const isDryRun = config.dryRun;
  logger.info({ mode: config.mode, asset: config.asset, strategy: config.strategy, dryRun: isDryRun }, "Starting exchange daemon");

  // Initialize adapters
  const dataDir = join(__dirname, "../data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "exchange.db");
  const store = new SqliteStore(dbPath);
  const eventLog = new EventLog(join(dataDir, "events.ndjson"));

  let hlClient: HlClient;
  let eventStream: HlEventStream | null = null;
  let env: ReturnType<typeof loadEnv>;

  if (isDryRun) {
    hlClient = new DryRunHlClient();
    env = { HL_ACCOUNT_ADDRESS: "dry-run", HL_PRIVATE_KEY: "dry-run" };
    logger.info("Dry-run mode: using DryRunHlClient (no SDK connection)");
  } else {
    env = loadEnv(config.mode);
    const sdk = new Hyperliquid({ privateKey: env.HL_PRIVATE_KEY, testnet: config.mode === "testnet" });
    await sdk.connect();
    logger.info("Connected to Hyperliquid");

    const realClient = new HyperliquidClient(sdk);
    await realClient.loadSzDecimals(config.asset);
    hlClient = realClient;
    eventStream = new HlEventStream(sdk, env.HL_ACCOUNT_ADDRESS);
  }

  const alertsClient = new HttpAlertsClient(config.gatewayUrl);
  const positionBook = new PositionBook();

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

  // Shared sync deps
  const syncDeps = { hlClient, positionBook, store, walletAddress: env.HL_ACCOUNT_ADDRESS, wsBroker };

  // Create shared deps
  const signalHandlerDeps: SignalHandlerDeps = {
    config,
    hlClient,
    store,
    eventLog,
    alertsClient,
    positionBook,
    onSignalProcessed: () => {
      wsBroker.broadcastEvent("positions", positionBook.getAll());
      wsBroker.broadcastEvent("orders", store.getRecentOrders(100));
      setTimeout(() => {
        hlClient.getOpenOrders(env.HL_ACCOUNT_ADDRESS).then((oo) => {
          wsBroker.broadcastEvent("open-orders", oo);
        }).catch((err) => {
          log.warn({ action: "postSignalOpenOrders", err }, "Failed to fetch open orders after signal");
        });
      }, 1500);
    },
  };

  // Initialize strategy, candle streamer, and candle cache
  const strategy = createStrategy(config.strategy);
  const streamer = new CandleStreamer({
    coin: config.asset,
    interval: config.interval,
    dataSource: config.dataSource,
  });
  const candleCache = new CandleCache(join(dataDir, "candles.db"));

  // Price ticker — broadcasts data source price + HL mid-price every ~5s
  const PRICE_TICK_MS = 5_000;
  let priceTickInterval: ReturnType<typeof setInterval> | null = null;
  function startPriceTicker() {
    priceTickInterval = setInterval(async () => {
      const latest = streamer.getLatest();
      const dataSourcePrice = latest?.c ?? null;
      const hlMidPrice = await hlClient.getMidPrice(config.asset);
      const trailingExitLevel = runner.getLastExitLevel();
      if (dataSourcePrice != null || hlMidPrice != null) {
        wsBroker.broadcastEvent("prices", { dataSourcePrice, hlMidPrice, trailingExitLevel });
      }
    }, PRICE_TICK_MS);
  }

  // Strategy runner
  const runner = new StrategyRunner({
    config,
    strategy,
    streamer,
    positionBook,
    signalHandlerDeps,
    eventLog,
    onNewCandle: (candle) => {
      wsBroker.broadcastEvent("candle", candle);
    },
    onStaleData: ({ lastCandleAt, silentMs }) => {
      const lastAt = lastCandleAt > 0 ? new Date(lastCandleAt).toISOString() : "never";
      const silentMin = Math.round(silentMs / 60_000);
      alertsClient.sendText(
        `⚠️ ${config.asset} candle data stale: no data for ${silentMin}min (last candle: ${lastAt}) — ${config.mode}`,
      ).catch(() => {});
    },
  });

  // Reconcile loop
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
    onApiDown: () => {
      alertsClient.sendText(
        `⚠️ Hyperliquid API appears down (3 consecutive reconcile failures) — ${config.mode}`,
      ).catch(() => {});
    },
  });

  // Startup sync
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
    streamer,
    candleCache,
    strategyFactory: () => createStrategy(config.strategy),
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "Exchange server listening");
  });

  // Attach WebSocket to same HTTP server
  wsBroker.attach(server);
  wsBroker.on("client:connected", async (ws: WebSocket) => {
    const snapshot = {
      positions: positionBook.getAll(),
      orders: store.getRecentOrders(100),
      openOrders: await hlClient.getOpenOrders(env.HL_ACCOUNT_ADDRESS).catch((err) => {
        log.warn({ action: "snapshotOpenOrders", err }, "Failed to fetch open orders for snapshot");
        return [];
      }),
      equity: store.getEquitySnapshots(500),
      health: { status: "ok", mode: config.mode, asset: config.asset, strategy: config.strategy, dryRun: isDryRun, uptime: process.uptime() },
      signals: store.getRecentSignals(100),
    };
    ws.send(JSON.stringify({ type: "snapshot", timestamp: new Date().toISOString(), data: snapshot }));
  });
  logger.info("WebSocket broker attached on /ws");

  await eventLog.append({
    type: "daemon_started",
    timestamp: new Date().toISOString(),
    data: { mode: config.mode, asset: config.asset, strategy: config.strategy, dryRun: isDryRun },
  });

  // Hyperliquid event stream (only in live mode)
  if (eventStream) {
    await eventStream.start({
      onOrderUpdate: (orders: WsOrder[]) => {
        for (const wsOrder of orders) {
          const oid = String(wsOrder.order.oid);
          const localOrder = store.getOrderByHlOid(oid);
          if (!localOrder || !localOrder.id) continue;

          const positionExists = positionBook.get(localOrder.coin) != null;
          const newStatus = resolveOrderStatus(wsOrder.status, positionExists);
          if (!newStatus) continue;

          const tsMs = wsOrder.statusTimestamp;
          const isValidTs = Number.isFinite(tsMs) && tsMs > 0 && tsMs <= Date.now() + 60_000;
          const filledAt = newStatus === "filled"
            ? (isValidTs ? new Date(tsMs).toISOString() : new Date().toISOString())
            : undefined;
          store.updateOrderStatus(localOrder.id, newStatus, filledAt);
          log.info({ oid, tag: localOrder.tag, status: newStatus }, `Order ${newStatus} (WS push)`);
        }

        syncPositionsAndBroadcast(syncDeps).catch((err) => {
          log.warn({ action: "syncAfterOrderUpdate", err }, "syncAndBroadcast failed after order update");
        });
      },

      onFill: (fills: WsUserFill[], isSnapshot: boolean) => {
        if (isSnapshot) return;
        syncPositionsAndBroadcast(syncDeps).catch((err) => {
          log.warn({ action: "syncAfterFill", err }, "syncAndBroadcast failed after fill");
        });
      },
    });
    logger.info("Subscribed to HL order updates and user fills");
  }

  // Start loops
  runner.start();
  reconciler.start();
  startPriceTicker();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    runner.stop();
    reconciler.stop();
    if (priceTickInterval) clearInterval(priceTickInterval);
    eventStream?.stop();
    wsBroker.close();

    await eventLog.append({
      type: "daemon_stopped",
      timestamp: new Date().toISOString(),
      data: {},
    });

    server.close();
    candleCache.close();
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
