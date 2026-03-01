import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hyperliquid } from "hyperliquid";
import { isMainModule } from "@breaker/kit";
import { createDonchianAdx, createKeltnerRsi2, createEmaPullback } from "@breaker/backtest";
import type { CandleInterval } from "@breaker/backtest";
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
import { recoverSlTp } from "./domain/recover-sl-tp.js";
import { StrategyRunner } from "./application/strategy-runner.js";
import { ReconcileLoop } from "./application/reconcile-loop.js";
import { resolveHistoricalStatuses } from "./application/resolve-historical-statuses.js";
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
    case "ema-pullback":
      return createEmaPullback();
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
    const localPos = positionBook.get(hlPos.coin);
    if (!localPos) {
      const recovered = recoverSlTp(hlPos.coin, hlPos.size, openOrders, hlPos.direction);
      positionBook.open({
        coin: hlPos.coin,
        direction: hlPos.direction,
        entryPrice: hlPos.entryPrice,
        size: hlPos.size,
        stopLoss: recovered.stopLoss,
        takeProfits: recovered.takeProfits,
        liquidationPx: hlPos.liquidationPx,
        trailingStopLoss: recovered.trailingStopLoss,
        leverage: hlPos.leverage,
        openedAt: new Date().toISOString(),
        signalId: -1,
      });
    } else {
      positionBook.updateLiquidationPx(hlPos.coin, hlPos.liquidationPx);
      // Recover SL/TP if lost (e.g. after daemon restart)
      if (localPos.stopLoss === 0) {
        const recovered = recoverSlTp(hlPos.coin, hlPos.size, openOrders, hlPos.direction);
        if (recovered.stopLoss > 0) {
          positionBook.updateStopLoss(hlPos.coin, recovered.stopLoss);
        }
        if (recovered.takeProfits.length > 0) {
          positionBook.updateTakeProfits(hlPos.coin, recovered.takeProfits);
        }
        positionBook.updateTrailingStopLoss(hlPos.coin, recovered.trailingStopLoss);
      }
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
    const resolvedOids = resolvedOrders.map((o) => Number(o.hl_order_id));
    const historicalMap = await resolveHistoricalStatuses(hlClient, walletAddress, resolvedOids);

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
  const allCoins = config.coins.map((c) => c.coin);
  logger.info({ mode: config.mode, coins: allCoins, dryRun: isDryRun }, "Starting exchange daemon");

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
    // loadSzDecimals caches all coins on first call
    await realClient.loadSzDecimals(allCoins[0]);
    hlClient = realClient;
    eventStream = new HlEventStream(sdk, env.HL_ACCOUNT_ADDRESS);
  }

  const alertsClient = new HttpAlertsClient(config.gatewayUrl);
  const positionBook = new PositionBook();

  // Set leverage per coin before any trading (parallel — independent per coin)
  await Promise.all(config.coins.map(async (coinCfg) => {
    await hlClient.setLeverage(coinCfg.coin, coinCfg.leverage, config.marginType === "cross");
    logger.info({ coin: coinCfg.coin, leverage: coinCfg.leverage }, "Leverage set");
    await eventLog.append({
      type: "leverage_set",
      timestamp: new Date().toISOString(),
      data: { coin: coinCfg.coin, leverage: coinCfg.leverage },
    });
  }));

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

  // CandleStreamer deduplication: key = "COIN:interval"
  const streamers = new Map<string, CandleStreamer>();
  for (const coinCfg of config.coins) {
    for (const strat of coinCfg.strategies) {
      const key = `${coinCfg.coin}:${strat.interval}`;
      if (!streamers.has(key)) {
        streamers.set(key, new CandleStreamer({
          coin: coinCfg.coin,
          interval: strat.interval,
          dataSource: config.dataSource,
        }));
      }
    }
  }

  const candleCache = new CandleCache(join(dataDir, "candles.db"));

  // StrategyRunner per (coin, strategy)
  const runners: StrategyRunner[] = [];
  for (const coinCfg of config.coins) {
    for (const strat of coinCfg.strategies) {
      const key = `${coinCfg.coin}:${strat.interval}`;
      const streamer = streamers.get(key)!;
      const strategy = createStrategy(strat.name);

      runners.push(new StrategyRunner({
        config,
        coin: coinCfg.coin,
        leverage: coinCfg.leverage,
        interval: strat.interval as CandleInterval,
        warmupBars: strat.warmupBars,
        autoTradingEnabled: strat.autoTradingEnabled,
        strategy,
        strategyConfigName: strat.name,
        streamer,
        positionBook,
        signalHandlerDeps,
        eventLog,
        onNewCandle: (candle) => {
          wsBroker.broadcastEvent("candle", { ...candle, coin: coinCfg.coin });
        },
        onStaleData: ({ lastCandleAt, silentMs }) => {
          const lastAt = lastCandleAt > 0 ? new Date(lastCandleAt).toISOString() : "never";
          const silentMin = Math.round(silentMs / 60_000);
          alertsClient.sendText(
            `⚠️ ${coinCfg.coin} candle data stale: no data for ${silentMin}min (last candle: ${lastAt}) — ${config.mode}`,
          ).catch(() => {});
        },
      }));
    }
  }

  // Pre-compute lookup maps for O(1) access in hot paths
  const coinStreamerMap = new Map<string, CandleStreamer>();
  const coinRunnersMap = new Map<string, StrategyRunner[]>();
  for (const coinCfg of config.coins) {
    const streamer = Array.from(streamers.entries()).find(([k]) => k.startsWith(`${coinCfg.coin}:`))?.[1];
    if (streamer) coinStreamerMap.set(coinCfg.coin, streamer);
    coinRunnersMap.set(coinCfg.coin, runners.filter((r) => r.getCoin() === coinCfg.coin));
  }

  // Price ticker — broadcasts data source price + HL mid-price every ~5s per coin
  const PRICE_TICK_MS = 5_000;
  let priceTickInterval: ReturnType<typeof setInterval> | null = null;
  function startPriceTicker() {
    priceTickInterval = setInterval(async () => {
      await Promise.all(config.coins.map(async (coinCfg) => {
        const streamer = coinStreamerMap.get(coinCfg.coin);
        const latest = streamer?.getLatest();
        const dataSourcePrice = latest?.c ?? null;
        const hlMidPrice = await hlClient.getMidPrice(coinCfg.coin);

        const coinRunners = coinRunnersMap.get(coinCfg.coin) ?? [];
        const trailingExitLevel = coinRunners.reduce<number | null>((acc, r) => acc ?? r.getLastExitLevel(), null);

        if (dataSourcePrice != null || hlMidPrice != null) {
          wsBroker.broadcastEvent("prices", {
            coin: coinCfg.coin,
            dataSourcePrice,
            hlMidPrice,
            trailingExitLevel,
          });
        }
      }));
    }, PRICE_TICK_MS);
  }

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

  // Warmup all runners in parallel (each fetches from independent APIs)
  logger.info({ runners: runners.map((r) => `${r.getCoin()}:${r.getInterval()}`) }, "Starting warmups...");
  await Promise.all(runners.map((r) => r.warmup()));
  logger.info("All warmups complete");

  // Express server
  const app = createApp({
    config,
    store,
    positionBook,
    hlClient,
    walletAddress: env.HL_ACCOUNT_ADDRESS,
    signalHandlerDeps,
    streamers,
    candleCache,
    strategyFactory: createStrategy,
    runners,
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "Exchange server listening");
  });

  // Attach WebSocket to same HTTP server
  wsBroker.attach(server);
  wsBroker.on("client:connected", async (ws: WebSocket) => {
    const coinsSummary = config.coins.map((c) => ({
      coin: c.coin,
      leverage: c.leverage,
      strategies: c.strategies.map((s) => ({ name: s.name, interval: s.interval, autoTradingEnabled: s.autoTradingEnabled })),
    }));
    const snapshot = {
      positions: positionBook.getAll(),
      orders: store.getRecentOrders(100),
      openOrders: await hlClient.getOpenOrders(env.HL_ACCOUNT_ADDRESS).catch((err) => {
        log.warn({ action: "snapshotOpenOrders", err }, "Failed to fetch open orders for snapshot");
        return [];
      }),
      equity: store.getEquitySnapshots(500),
      health: { status: "ok", mode: config.mode, coins: coinsSummary, dryRun: isDryRun, uptime: process.uptime() },
      signals: store.getRecentSignals(100),
    };
    ws.send(JSON.stringify({ type: "snapshot", timestamp: new Date().toISOString(), data: snapshot }));
  });
  logger.info("WebSocket broker attached on /ws");

  await eventLog.append({
    type: "daemon_started",
    timestamp: new Date().toISOString(),
    data: { mode: config.mode, coins: allCoins, dryRun: isDryRun },
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

  // Start all runners and loops
  for (const runner of runners) runner.start();
  reconciler.start();
  startPriceTicker();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    for (const runner of runners) runner.stop();
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
