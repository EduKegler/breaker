import { CandleCache } from "./data/candle-cache.js";
import type { CandleClientOptions } from "./data/candle-client.js";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "./engine/engine.js";
import { computeMetrics } from "./analysis/metrics-calculator.js";
import { analyzeTradeList } from "./analysis/trade-analysis.js";
import { createDonchianAdx } from "./strategies/donchian-adx.js";
import { createKeltnerRsi2 } from "./strategies/keltner-rsi2.js";
import path from "node:path";
import fs from "node:fs";

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/run-backtest.js");

if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const warmupIdx = argv.indexOf("--warmup");
  const WARMUP_DAYS = warmupIdx !== -1 ? parseInt(argv[warmupIdx + 1], 10) : 60;

  // Parse named flags
  const startIdx = argv.indexOf("--start");
  const endIdx = argv.indexOf("--end");
  const startDate = startIdx !== -1 ? argv[startIdx + 1] : undefined;
  const endDate = endIdx !== -1 ? argv[endIdx + 1] : undefined;

  // Positional args: filter out --flag and their values
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--start" || argv[i] === "--end" || argv[i] === "--warmup" || argv[i] === "--strategy") {
      i++; // skip value
    } else if (!argv[i].startsWith("--")) {
      positional.push(argv[i]);
    }
  }

  const coin = positional[0] ?? "BTC";
  const source = (startDate
    ? positional[1] ?? "bybit"
    : positional[2] ?? "bybit") as "bybit" | "coinbase" | "coinbase-perp" | "hyperliquid";
  const interval = "15m" as const;

  let startTime: number;
  let endTime: number;
  let days: number;

  if (startDate) {
    startTime = new Date(startDate + "T00:00:00Z").getTime();
    endTime = endDate ? new Date(endDate + "T23:59:59Z").getTime() : Date.now();
    days = Math.ceil((endTime - startTime) / 86_400_000);
  } else {
    days = parseInt(positional[1] ?? "180", 10);
    endTime = Date.now();
    startTime = endTime - days * 86_400_000;
  }

  // Fetch extra candles before startTime so indicators (EMA50 daily) can warm up
  const dataStartTime = startDate ? startTime - WARMUP_DAYS * 86_400_000 : startTime;

  // Ensure cache directory exists
  const cacheDir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const dbPath = path.join(cacheDir, "candles.db");
  const cache = new CandleCache(dbPath);

  const clientOpts: CandleClientOptions = { source };
  console.log(`Syncing ${coin} ${interval} candles (${source})...`);
  const syncResult = await cache.sync(coin, interval, dataStartTime, endTime, clientOpts);
  console.log(`  Fetched: ${syncResult.fetched}, Total cached: ${syncResult.cached}`);

  // Also sync higher timeframes
  for (const tf of ["1h", "1d"] as const) {
    console.log(`Syncing ${coin} ${tf} candles (${source})...`);
    const htfResult = await cache.sync(coin, tf, dataStartTime, endTime, clientOpts);
    console.log(`  Fetched: ${htfResult.fetched}, Total cached: ${htfResult.cached}`);
  }

  // Load candles from cache (includes warmup period)
  const candles = cache.getCandles(coin, interval, dataStartTime, endTime, source);
  console.log(`\nLoaded ${candles.length} candles for backtest`);

  cache.close();

  if (candles.length === 0) {
    console.error("No candles available. Run sync first.");
    process.exit(1);
  }

  // Run backtest
  const strategyIdx = argv.indexOf("--strategy");
  const strategyName = strategyIdx !== -1 ? argv[strategyIdx + 1] : "donchian-adx";
  const strategy = strategyName === "keltner-rsi2" ? createKeltnerRsi2() : createDonchianAdx();
  const useCash = process.argv.includes("--cash");
  const noLimits = process.argv.includes("--no-limits");
  const config = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...(useCash ? { sizingMode: "cash" as const, cashPerTrade: 100 } : {}),
    ...(noLimits ? {
      cooldownBars: 0,
      maxConsecutiveLosses: Number.MAX_SAFE_INTEGER,
      dailyLossLimitUsd: Number.MAX_SAFE_INTEGER,
      maxTradesPerDay: Number.MAX_SAFE_INTEGER,
    } : {}),
  };
  const flags = [useCash ? "cash" : null, noLimits ? "no-limits" : null].filter(Boolean);
  console.log(`Running backtest: ${strategy.name}${flags.length ? ` (${flags.join(", ")})` : ""}`);

  const result = runBacktest(candles, strategy, config, interval);

  // Filter trades to user-specified window (exclude warmup-period trades)
  const trades = startDate
    ? result.trades.filter(t => t.entryTimestamp >= startTime)
    : result.trades;

  if (startDate) {
    console.log(`  All engine trades: ${result.trades.length}, after filtering to window: ${trades.length}`);
  }

  // Compute metrics on filtered trades
  const metrics = computeMetrics(trades, result.maxDrawdownPct);
  const analysis = analyzeTradeList(trades);

  // Output results
  console.log("\n=== Backtest Results ===");
  console.log(`Period: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)} (${days} days${startDate ? `, +${WARMUP_DAYS}d warmup` : ""})`);
  console.log(`Bars processed: ${result.barsProcessed}`);
  console.log(`Trades: ${metrics.numTrades}`);
  console.log(`Total PnL: $${metrics.totalPnl?.toFixed(2)}`);
  console.log(`Profit Factor: ${metrics.profitFactor?.toFixed(2) ?? "N/A"}`);
  console.log(`Win Rate: ${metrics.winRate?.toFixed(1) ?? "N/A"}%`);
  console.log(`Max Drawdown: ${metrics.maxDrawdownPct?.toFixed(2) ?? "N/A"}%`);
  console.log(`Avg R: ${metrics.avgR?.toFixed(2) ?? "N/A"}`);
  console.log(`Final Equity: $${result.finalEquity.toFixed(2)}`);

  if (analysis.byDirection["Long"]) {
    console.log(`\nLong trades: ${analysis.byDirection["Long"].count} (WR: ${analysis.byDirection["Long"].winRate.toFixed(1)}%)`);
  }
  if (analysis.byDirection["Short"]) {
    console.log(`Short trades: ${analysis.byDirection["Short"].count} (WR: ${analysis.byDirection["Short"].winRate.toFixed(1)}%)`);
  }

  if (analysis.walkForward) {
    console.log(`\nWalk-Forward: Train PF=${analysis.walkForward.trainPF?.toFixed(2)}, Test PF=${analysis.walkForward.testPF?.toFixed(2)}, Ratio=${analysis.walkForward.pfRatio?.toFixed(2)}`);
    console.log(`  Overfit flag: ${analysis.walkForward.overfitFlag}`);
  }

  // Print individual trades for TV comparison
  if (trades.length > 0) {
    console.log("\n=== Trade List ===");
    for (const t of trades) {
      const entry = new Date(t.entryTimestamp).toISOString().slice(0, 16);
      const exit = new Date(t.exitTimestamp).toISOString().slice(0, 16);
      console.log(
        `  ${t.direction.toUpperCase().padEnd(5)} | ${entry} → ${exit} | ` +
        `entry=${t.entryPrice.toFixed(2)} exit=${t.exitPrice.toFixed(2)} | ` +
        `PnL=$${t.pnl.toFixed(2)} (${t.rMultiple.toFixed(2)}R) | ${t.exitType} | ${t.exitComment}`,
      );
    }
  }

  // Output full JSON for piping
  const output = { metrics, analysis, config };
  console.log("\n" + JSON.stringify(output, null, 2));
}
