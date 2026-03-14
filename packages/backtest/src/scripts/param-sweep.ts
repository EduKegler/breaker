import { createDonchianBreakoutPure } from "../strategies/btc/trend-following/donchian-breakout-pure.js";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "../engine/engine.js";
import { computeMetrics } from "../analysis/metrics-calculator.js";
import { computeMinWarmupBars } from "../engine/compute-min-warmup-bars.js";
import { CandleCache } from "../data/candle-cache.js";
import type { Candle } from "../types/candle.js";
import type { CompletedTrade } from "../types/order.js";
import path from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "@breaker/kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let effectiveWarmup = 200;

function test(label: string, overrides: Record<string, number>, candles: Candle[]): void {
  const strategy = createDonchianBreakoutPure(overrides);
  const warmupBars = computeMinWarmupBars(strategy, "4h");
  const result = runBacktest(candles, strategy, {
    ...DEFAULT_BACKTEST_CONFIG,
    warmupBars: Math.max(warmupBars, effectiveWarmup),
  }, "4h");

  const m = computeMetrics(result.trades, result.maxDrawdownPct);
  const trades = result.trades as CompletedTrade[];
  const longs = trades.filter(t => t.direction === "long");
  const shorts = trades.filter(t => t.direction === "short");
  const longWins = longs.filter(t => t.pnl > 0).length;
  const shortWins = shorts.filter(t => t.pnl > 0).length;
  const longWR = longs.length > 0 ? ((longWins / longs.length) * 100).toFixed(0) : "-";
  const shortWR = shorts.length > 0 ? ((shortWins / shorts.length) * 100).toFixed(0) : "-";

  console.log(
    `${label.padEnd(25)} PF=${(m.profitFactor ?? 0).toFixed(2).padStart(5)}  Trd=${String(m.numTrades).padStart(4)}  WR=${(m.winRate ?? 0).toFixed(0).padStart(3)}%  DD=${Math.abs(m.maxDrawdownPct ?? 0).toFixed(1).padStart(5)}%  AvgR=${(m.avgR ?? 0).toFixed(3).padStart(7)}  PnL=$${(m.totalPnl ?? 0).toFixed(0).padStart(5)}  L:${longs.length}(${longWR}%) S:${shorts.length}(${shortWR}%)`,
  );
}

if (isMainModule(import.meta.url)) {
  const dbPath = path.join(__dirname, "../../.cache/candles.db");
  const cache = new CandleCache(dbPath);
  const end = Date.now();
  const startTime = end - 180 * 86400000;
  const WARMUP_DAYS = 730;
  const dataStartTime = startTime - WARMUP_DAYS * 86400000;

  // Sync candles including warmup period (same as compare script)
  console.log("Syncing candles...");
  await cache.sync("BTC", "4h", dataStartTime, end);
  await cache.sync("BTC", "1d", dataStartTime, end);

  const candles = cache.getCandles("BTC", "4h", dataStartTime, end, "binance");
  cache.close();

  if (candles.length === 0) {
    console.error("No candles found in cache");
    process.exit(1);
  }

  // Set warmup to match compare script: candles before startTime are warmup
  effectiveWarmup = candles.findIndex(c => c.t >= startTime);
  if (effectiveWarmup < 0) effectiveWarmup = 200;

  console.log(`Candles: ${candles.length} (${new Date(candles[0].t).toISOString().slice(0, 10)} to ${new Date(candles[candles.length - 1].t).toISOString().slice(0, 10)})`);
  console.log(`Effective warmup: ${effectiveWarmup} bars (trading starts at index ${effectiveWarmup})`);
  console.log("");
  console.log("=== ENTRY/EXIT PERIOD SWEEP ===");
  test("Default 120/60", {}, candles);
  test("E90/X60", { entryBars: 90 }, candles);
  test("E72/X60", { entryBars: 72 }, candles);
  test("E120/X30", { exitBars: 30 }, candles);
  test("E120/X42", { exitBars: 42 }, candles);
  test("E72/X30", { entryBars: 72, exitBars: 30 }, candles);
  test("E48/X24", { entryBars: 48, exitBars: 24 }, candles);
  test("E36/X18", { entryBars: 36, exitBars: 18 }, candles);
  test("E180/X60", { entryBars: 180 }, candles);
  test("E180/X30", { entryBars: 180, exitBars: 30 }, candles);

  console.log("");
  console.log("=== STOP MULTIPLIER SWEEP ===");
  test("Stop2.0", { atrStopMult: 2.0 }, candles);
  test("Stop2.5", { atrStopMult: 2.5 }, candles);
  test("Stop3.0 (default)", { atrStopMult: 3.0 }, candles);
  test("Stop4.0", { atrStopMult: 4.0 }, candles);
  test("Stop5.0", { atrStopMult: 5.0 }, candles);

  console.log("");
  console.log("=== BEST COMBOS ===");
  test("E72/X30/S2.0", { entryBars: 72, exitBars: 30, atrStopMult: 2.0 }, candles);
  test("E72/X30/S2.5", { entryBars: 72, exitBars: 30, atrStopMult: 2.5 }, candles);
  test("E48/X24/S2.0", { entryBars: 48, exitBars: 24, atrStopMult: 2.0 }, candles);
  test("E120/X30/S2.0", { entryBars: 120, exitBars: 30, atrStopMult: 2.0 }, candles);
  test("E90/X30/S2.5", { entryBars: 90, exitBars: 30, atrStopMult: 2.5 }, candles);
  test("E120/X42/S2.5", { entryBars: 120, exitBars: 42, atrStopMult: 2.5 }, candles);
  test("E90/X42/S3.0", { entryBars: 90, exitBars: 42, atrStopMult: 3.0 }, candles);
}
