import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hyperliquid } from "hyperliquid";
import { isMainModule } from "@breaker/kit";
import { createDonchianAdx, createKeltnerRsi2, createEmaPullback } from "@breaker/backtest/deployed";
import { computeMinWarmupBars } from "@breaker/backtest";
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
import { PendingEntryBook } from "./domain/pending-entry-book.js";
import { resolveOrderStatus } from "./domain/order-status.js";
import { processPendingFill } from "./application/process-pending-fill.js";
import { recoverSlTp } from "./domain/recover-sl-tp.js";
import { Orchestrator, type ModuleType } from "./domain/orchestrator.js";
import { StrategyRunner } from "./application/strategy-runner.js";
import { ReconcileLoop } from "./application/reconcile-loop.js";
import { resolveHistoricalStatuses } from "./application/resolve-historical-statuses.js";
import { createApp } from "./create-app.js";
import { replayStrategy } from "./application/replay-strategy.js";
import { fetchCandlesForReplay, SIGNAL_WINDOW } from "./application/fetch-candles-for-replay.js";
import { aggregatePositionHistory } from "./domain/aggregate-position-history.js";
import { WsBroker } from "./lib/ws-broker.js";
import type { HlClient } from "./types/hl-client.js";
import type { SignalHandlerDeps } from "./application/handle-signal.js";
import type WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = logger.createChild("daemon");

const configPath = join(__dirname, "../exchange-config.json");

function loadConfig(): ExchangeConfig {
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
  eventLog: EventLog;
  orchestrator?: Orchestrator;
}): Promise<void> {
  const { hlClient, positionBook, store, walletAddress, wsBroker, eventLog } = deps;
  const [hlPositions, openOrders] = await Promise.all([
    hlClient.getPositions(walletAddress),
    hlClient.getOpenOrders(walletAddress),
  ]);

  // Sync PositionBook with HL truth
  const hlCoins = new Set(hlPositions.map((p) => p.coin));
  for (const local of positionBook.getAll()) {
    if (!hlCoins.has(local.coin)) {
      const pnl = (local.unrealizedPnl ?? 0) + (local.cumulativeFunding ?? 0);
      positionBook.close(local.coin);

      // Record PnL in orchestrator so daily loss gate stays accurate
      if (deps.orchestrator) {
        const moduleId = `${local.coin}:${local.strategyName ?? "unknown"}`;
        deps.orchestrator.recordClose(moduleId, pnl);
        log.info({ coin: local.coin, pnl, dailyPnl: deps.orchestrator.getDailyPnl() },
          "WS sync: recorded PnL in orchestrator");
      }

      log.info({ coin: local.coin, pnl }, "Position closed (WS event)");
      eventLog.append({
        type: "position_closed",
        timestamp: new Date().toISOString(),
        data: {
          coin: local.coin,
          direction: local.direction,
          entryPrice: local.entryPrice,
          pnl,
          reason: "ws_sync",
        },
      }).catch(() => {});
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
        signalId: store.getOpenSignalId(hlPos.coin) ?? -1,
        strategyName: store.getStrategyForCoin(hlPos.coin),
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
  wsBroker.broadcastEvent("position-history", aggregatePositionHistory(store.getPositionHistoryRows(500)));
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
  const pendingEntryBook = new PendingEntryBook();

  // Set leverage per coin before any trading (parallel — independent per coin)
  await Promise.all(config.coins.map(async (coinCfg) => {
    await hlClient.setLeverage(coinCfg.coin, coinCfg.leverage, config.marginType === "cross");
    await eventLog.append({
      type: "leverage_set",
      timestamp: new Date().toISOString(),
      data: { coin: coinCfg.coin, leverage: coinCfg.leverage },
    });
  }));

  // WebSocket broker
  const wsBroker = new WsBroker();

  // Shared sync deps (orchestrator added after creation below)
  const syncDeps: Parameters<typeof syncPositionsAndBroadcast>[0] = { hlClient, positionBook, store, walletAddress: env.HL_ACCOUNT_ADDRESS, wsBroker, eventLog };

  // Create shared deps
  const signalHandlerDeps: SignalHandlerDeps = {
    config,
    hlClient,
    store,
    eventLog,
    alertsClient,
    positionBook,
    pendingEntryBook,
    onSignalProcessed: () => {
      wsBroker.broadcastEvent("positions", positionBook.getAll());
      wsBroker.broadcastEvent("orders", store.getRecentOrders(100));
      wsBroker.broadcastEvent("position-history", aggregatePositionHistory(store.getPositionHistoryRows(500)));
      wsBroker.broadcastEvent("signals", store.getRecentSignals(100));
      wsBroker.broadcastEvent("pending-entries", pendingEntryBook.getAll());
      setTimeout(() => {
        hlClient.getOpenOrders(env.HL_ACCOUNT_ADDRESS).then((oo) => {
          wsBroker.broadcastEvent("open-orders", oo);
        }).catch((err) => {
          log.warn({ action: "postSignalOpenOrders", err }, "Failed to fetch open orders after signal");
        });
      }, 1500);
    },
  };

  // Orchestrator: centralized daily PnL, trade count, signal deconfliction
  const MODULE_TYPE_FALLBACK: Record<string, ModuleType> = {
    "donchian-adx": "breakout",
    "keltner-rsi2": "mean-reversion",
    "ema-pullback": "pullback",
  };

  const orchestrator = new Orchestrator({
    maxDailyLossR: config.guardrails.maxDailyLossR,
    riskPerTradeUsd: config.sizing.riskPerTradeUsd,
    maxTradesPerDay: config.guardrails.maxTradesPerDay,
    volSpikeThresholdPct: config.guardrails.volSpikeThresholdPct,
    volSpikeLookbackBars: config.guardrails.volSpikeLookbackBars,
    volSpikeCooldownBars: config.guardrails.volSpikeCooldownBars,
  });
  syncDeps.orchestrator = orchestrator;

  // Seed orchestrator with today's realized PnL from SQLite so the daily loss
  // gate is accurate even after daemon restarts (orchestrator starts at 0).
  const todayPnl = store.getTodayRealizedPnl();
  if (todayPnl !== 0) {
    orchestrator.seedDailyPnl(todayPnl);
    logger.info({ todayPnl }, "Orchestrator seeded with today's realized PnL from DB");
  }

  for (const coinCfg of config.coins) {
    for (const strat of coinCfg.strategies) {
      const moduleType: ModuleType = strat.moduleType ?? MODULE_TYPE_FALLBACK[strat.name] ?? "breakout";
      orchestrator.registerModule(`${coinCfg.coin}:${strat.name}`, moduleType);
    }
  }

  orchestrator.setDecisionCallback((d) => {
    eventLog.append({
      type: `orchestrator_${d.type}`,
      timestamp: d.timestamp,
      data: { moduleId: d.moduleId, ...d.data },
    }).catch(() => {});
  });

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

  // Register candle broadcast: 1 listener per coin on the streamer (not per runner).
  // This prevents duplicate WS broadcasts when a coin has multiple strategies.
  const broadcastedStreamers = new Set<string>();
  for (const coinCfg of config.coins) {
    for (const strat of coinCfg.strategies) {
      const key = `${coinCfg.coin}:${strat.interval}`;
      if (broadcastedStreamers.has(key)) continue;
      broadcastedStreamers.add(key);
      const streamer = streamers.get(key);
      if (!streamer) continue;
      streamer.on("candle:tick", (candle) => {
        wsBroker.broadcastEvent("candle", { ...candle, coin: coinCfg.coin });
      });
    }
  }

  // StrategyRunner per (coin, strategy)
  const runners: StrategyRunner[] = [];
  for (const coinCfg of config.coins) {
    for (const strat of coinCfg.strategies) {
      const key = `${coinCfg.coin}:${strat.interval}`;
      const streamer = streamers.get(key)!;
      const strategy = createStrategy(strat.name);

      const minRequired = computeMinWarmupBars(strategy, strat.interval as CandleInterval);
      const effectiveWarmup = Math.max(strat.warmupBars, minRequired);
      if (minRequired > strat.warmupBars) {
        log.warn(
          { coin: coinCfg.coin, strategy: strat.name, configured: strat.warmupBars, required: minRequired, effective: effectiveWarmup },
          "Config warmupBars is below strategy minimum — auto-corrected",
        );
      }

      runners.push(new StrategyRunner({
        config,
        coin: coinCfg.coin,
        leverage: coinCfg.leverage,
        interval: strat.interval as CandleInterval,
        warmupBars: effectiveWarmup,
        autoTradingEnabled: strat.autoTradingEnabled,
        strategy,
        strategyConfigName: strat.name,
        streamer,
        positionBook,
        signalHandlerDeps,
        eventLog,
        orchestrator,
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
    pendingEntryBook,
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
    onAutoClose: (coin, strategyName, pnl) => {
      const moduleId = `${coin}:${strategyName ?? "unknown"}`;
      orchestrator.recordClose(moduleId, pnl);
      log.warn({ coin, strategyName, pnl, dailyPnl: orchestrator.getDailyPnl() },
        `Reconcile auto-close: recorded PnL $${pnl.toFixed(2)} in orchestrator`);
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
    logger.info({ actions: startupResult.actions, drifts: startupResult.drifts.length }, "Startup corrections applied");
  } else {
    logger.info({ drifts: startupResult.drifts.length }, "Startup reconciliation: no corrections needed");
  }

  // Warmup all runners in parallel (each fetches from independent APIs)
  logger.info({ runners: runners.map((r) => `${r.getCoin()}:${r.getStrategyName()}:${r.getInterval()}`) }, "Starting warmups...");
  await Promise.all(runners.map((r) => r.warmup()));
  logger.info("All warmups complete");

  // Express server
  const { app, replayCache, replayDeps } = createApp({
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
    orchestrator,
    persistConfig: () => {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
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
      positionHistory: aggregatePositionHistory(store.getPositionHistoryRows(500)),
      pendingEntries: pendingEntryBook.getAll(),
    };
    ws.send(JSON.stringify({ type: "snapshot", timestamp: new Date().toISOString(), data: snapshot }));
  });
  logger.info("WebSocket broker attached on /ws");

  // Replay signal broadcast: on candle close, re-run replay for each strategy
  // and push the results via WS so the explorer updates without F5.
  const replayBroadcastedStreamers = new Set<string>();
  for (const coinCfg of config.coins) {
    for (const strat of coinCfg.strategies) {
      const key = `${coinCfg.coin}:${strat.interval}`;
      if (replayBroadcastedStreamers.has(key)) continue;
      replayBroadcastedStreamers.add(key);
      const streamer = streamers.get(key);
      if (!streamer) continue;

      streamer.on("candle:close", async () => {
        const now = Date.now();
        // Iterate all strategies for this coin+interval
        const coinStrategies = coinCfg.strategies.filter((s) => s.interval === strat.interval);
        for (const stratCfg of coinStrategies) {
          try {
            const interval = stratCfg.interval as CandleInterval;
            const strategy = createStrategy(stratCfg.name);
            const minWarmup = computeMinWarmupBars(strategy, interval);
            const replayBars = minWarmup + SIGNAL_WINDOW;
            const candles = await fetchCandlesForReplay(replayDeps, coinCfg.coin, interval, now, replayBars);
            const signals = replayStrategy({
              strategyFactory: () => createStrategy(stratCfg.name),
              candles,
              interval,
              strategyName: stratCfg.name,
            });

            wsBroker.broadcastEvent("replay-signals", {
              coin: coinCfg.coin,
              strategyName: stratCfg.name,
              signals,
            });

            // Invalidate HTTP cache for this strategy
            const cacheKey = `${coinCfg.coin}:${stratCfg.name}:${interval}`;
            replayCache.delete(cacheKey);

            // Divergence detection: compare live runner result with replay
            const coinRunners = coinRunnersMap.get(coinCfg.coin) ?? [];
            const runner = coinRunners.find((r) => r.getStrategyName() === stratCfg.name);
            if (runner) {
              const liveResult = runner.getLastSignalResult();
              const lastReplaySignal = signals.length > 0 ? signals[signals.length - 1] : null;
              const replayHadSignal = lastReplaySignal != null &&
                candles.length > 0 &&
                lastReplaySignal.t === candles[candles.length - 1].t;

              if (liveResult && replayHadSignal && !liveResult.hadSignal) {
                log.warn({
                  action: "liveReplayDivergence",
                  coin: coinCfg.coin,
                  strategy: stratCfg.name,
                  liveHadSignal: liveResult.hadSignal,
                  replayDirection: lastReplaySignal.direction,
                  replayEntryPrice: lastReplaySignal.entryPrice,
                  liveCandleT: liveResult.t,
                  replayCandleT: lastReplaySignal.t,
                }, "Live runner missed signal that replay found — possible WS/REST data divergence");
              }
            }
          } catch (err) {
            log.warn(
              { action: "replayBroadcastFailed", coin: coinCfg.coin, strategy: stratCfg.name, err },
              "Failed to broadcast replay signals",
            );
          }
        }
      });
    }
  }

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

        for (const fill of fills) {
          // Check if this fill matches a pending GTC entry
          processPendingFill(fill, {
            pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode: config.mode,
          }).catch((err) => {
            log.error({ oid: fill.oid, err }, "Failed to process pending GTC fill");
          });

          const localOrder = store.getOrderByHlOid(String(fill.oid));
          if (!localOrder || localOrder.id == null) continue;
          try {
            store.insertFill({
              order_id: localOrder.id,
              price: parseFloat(fill.px),
              size: parseFloat(fill.sz),
              fee: parseFloat(fill.fee),
              timestamp: new Date(fill.time).toISOString(),
            });
            log.info({ oid: fill.oid, tag: localOrder.tag, price: fill.px, size: fill.sz }, "Fill recorded");
          } catch (err) {
            log.warn({ oid: fill.oid, err }, "Failed to record fill (may be duplicate)");
          }
        }

        syncPositionsAndBroadcast(syncDeps).catch((err) => {
          log.warn({ action: "syncAfterFill", err }, "syncAndBroadcast failed after fill");
        });
      },

      onReconnected: () => {
        syncPositionsAndBroadcast(syncDeps).catch((err) => {
          log.warn({ action: "syncAfterReconnect", err }, "syncAndBroadcast failed after WS reconnect");
        });
        eventLog.append({
          type: "ws_reconnected",
          timestamp: new Date().toISOString(),
          data: {},
        }).catch(() => {});
      },

      onDisconnected: (code: number, reason: string) => {
        eventLog.append({
          type: "ws_disconnected",
          timestamp: new Date().toISOString(),
          data: { code, reason },
        }).catch(() => {});
      },

      onMaxReconnectFailed: () => {
        eventLog.append({
          type: "ws_max_reconnect_failed",
          timestamp: new Date().toISOString(),
          data: {},
        }).catch(() => {});
        alertsClient.sendText(
          `🚨 WebSocket DEAD — max reconnect attempts reached. Daemon is blind (no fills/orders). Manual restart required — ${config.mode}`,
        ).catch(() => {});
      },
    });
    logger.info("Subscribed to HL order updates and user fills");
  }

  // Start all runners and loops
  for (const runner of runners) runner.start();
  reconciler.start();
  startPriceTicker();

  // Orchestrator heartbeat: force close open positions when daily loss >= 2R.
  // SL can be hit between candle closes — this timer ensures force close is
  // evaluated every 30s, not only on candle close events.
  const HEARTBEAT_MS = 30_000;
  const heartbeatInterval = setInterval(async () => {
    if (!orchestrator.shouldForceClose()) return;
    const openPositions = positionBook.getAll();
    if (openPositions.length === 0) return;

    for (const pos of openPositions) {
      log.warn({ coin: pos.coin, dailyPnl: orchestrator.getDailyPnl() },
        "ORCHESTRATOR: Force closing — daily loss >= 2R");
      try {
        const pnl = (pos.unrealizedPnl ?? 0) + (pos.cumulativeFunding ?? 0);
        const closeSide = pos.direction === "long" ? "sell" : "buy";
        await hlClient.placeMarketOrder(pos.coin, closeSide === "buy", pos.size);
        positionBook.close(pos.coin);
        const moduleId = `${pos.coin}:${pos.strategyName ?? "unknown"}`;
        orchestrator.recordClose(moduleId, pnl);
        eventLog.append({
          type: "orchestrator_force_close",
          timestamp: new Date().toISOString(),
          data: { coin: pos.coin, direction: pos.direction, pnl, dailyPnl: orchestrator.getDailyPnl() },
        }).catch(() => {});
        alertsClient.sendText(
          `FORCE CLOSE: ${pos.coin} ${pos.direction} — daily loss >= 2R ($${orchestrator.getDailyPnl().toFixed(2)})`,
        ).catch(() => {});
      } catch (err) {
        log.error({ coin: pos.coin, err }, "Force close failed");
      }
    }
  }, HEARTBEAT_MS);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    for (const runner of runners) runner.stop();
    reconciler.stop();
    if (priceTickInterval) clearInterval(priceTickInterval);
    clearInterval(heartbeatInterval);
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
