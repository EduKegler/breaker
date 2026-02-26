import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "@breaker/kit";
import { createDonchianAdx, createKeltnerRsi2 } from "@breaker/backtest";
import { ExchangeConfigSchema, type ExchangeConfig } from "./types/config.js";
import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { SqliteStore } from "./adapters/sqlite-store.js";
import { EventLog } from "./adapters/event-log.js";
import { HyperliquidClient } from "./adapters/hyperliquid-client.js";
import { CandlePoller } from "./adapters/candle-poller.js";
import { HttpAlertsClient } from "./adapters/alerts-client.js";
import { PositionBook } from "./domain/position-book.js";
import { StrategyRunner } from "./application/strategy-runner.js";
import { ReconcileLoop } from "./application/reconcile-loop.js";
import { createApp } from "./server.js";
import type { SignalHandlerDeps } from "./application/signal-handler.js";

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
  logger.info({ mode: config.mode, asset: config.asset, strategy: config.strategy }, "Starting exchange daemon");

  // Initialize adapters
  const dbPath = join(__dirname, "../data/exchange.db");
  const store = new SqliteStore(dbPath);
  const eventLog = new EventLog(join(__dirname, "../data/events.ndjson"));
  const hlClient = new HyperliquidClient(env.HL_PRIVATE_KEY, config.mode === "testnet");
  const alertsClient = new HttpAlertsClient(config.gatewayUrl);
  const positionBook = new PositionBook();

  await hlClient.connect();
  logger.info("Connected to Hyperliquid");

  // Set leverage before any trading
  await hlClient.setLeverage(config.asset, config.leverage, config.marginType === "cross");
  logger.info({ asset: config.asset, leverage: config.leverage }, "Leverage set");

  await eventLog.append({
    type: "leverage_set",
    timestamp: new Date().toISOString(),
    data: { asset: config.asset, leverage: config.leverage },
  });

  // Create shared deps
  const signalHandlerDeps: SignalHandlerDeps = {
    config,
    hlClient,
    store,
    eventLog,
    alertsClient,
    positionBook,
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
  });

  // Warmup
  logger.info({ bars: config.warmupBars }, "Starting warmup...");
  await runner.warmup();
  logger.info("Warmup complete");

  // Reconcile loop
  const reconciler = new ReconcileLoop({
    hlClient,
    positionBook,
    eventLog,
    walletAddress: env.HL_ACCOUNT_ADDRESS,
    intervalMs: 60_000,
  });

  // Express server
  const app = createApp({
    config,
    store,
    positionBook,
    hlClient,
    signalHandlerDeps,
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, "Exchange server listening");
  });

  await eventLog.append({
    type: "daemon_started",
    timestamp: new Date().toISOString(),
    data: { mode: config.mode, asset: config.asset, strategy: config.strategy },
  });

  // Start loops
  runner.start();
  reconciler.start();

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    runner.stop();
    reconciler.stop();

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
