import { createDonchianBreakoutPure } from "../strategies/btc/trend-following/donchian-breakout-pure.js";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "../engine/engine.js";
import { computeMetrics } from "../analysis/metrics-calculator.js";
import { computeMinWarmupBars } from "../engine/compute-min-warmup-bars.js";
import { CandleCache } from "../data/candle-cache.js";
import { donchian } from "../indicators/donchian.js";
import path from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "@breaker/kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (isMainModule(import.meta.url)) {
  const dbPath = path.join(__dirname, "../../.cache/candles.db");
  const cache = new CandleCache(dbPath);
  const end = Date.now();
  const startTime = end - 180 * 86400000;
  const WARMUP_DAYS = 730;
  const dataStartTime = startTime - WARMUP_DAYS * 86400000;

  const candles = cache.getCandles("BTC", "4h", dataStartTime, end, "binance");
  cache.close();

  console.log(`Total candles: ${candles.length}`);

  const strategy = createDonchianBreakoutPure({});
  const warmupBars = computeMinWarmupBars(strategy, "4h");
  const effectiveWarmup = candles.findIndex(c => c.t >= startTime);
  const finalWarmup = Math.max(warmupBars, effectiveWarmup);

  console.log(`computeMinWarmupBars: ${warmupBars}`);
  console.log(`effectiveWarmup (index of startTime): ${effectiveWarmup}`);
  console.log(`finalWarmup: ${finalWarmup}`);
  console.log(`Trading bars: ${candles.length - finalWarmup}`);

  // Manual Donchian check
  const dc = donchian(candles, 120);
  let breakoutCount = 0;
  for (let i = finalWarmup; i < candles.length; i++) {
    const close = candles[i].c;
    const upper = dc.upper[i - 1];
    const lower = dc.lower[i - 1];
    if (!isNaN(upper) && close > upper) breakoutCount++;
    if (!isNaN(lower) && close < lower) breakoutCount++;
  }
  console.log(`Breakout signals (close > upper OR close < lower) in trading window: ${breakoutCount}`);

  // Run backtest with same config as compare
  const result = runBacktest(candles, strategy, {
    ...DEFAULT_BACKTEST_CONFIG,
    warmupBars: finalWarmup,
  }, "4h");

  const m = computeMetrics(result.trades, result.maxDrawdownPct);
  console.log(`\nBacktest result:`);
  console.log(`  Trades: ${m.numTrades}`);
  console.log(`  PF: ${(m.profitFactor ?? 0).toFixed(2)}`);
  console.log(`  WR: ${(m.winRate ?? 0).toFixed(1)}%`);
  console.log(`  AvgR: ${(m.avgR ?? 0).toFixed(3)}`);
  console.log(`  PnL: $${(m.totalPnl ?? 0).toFixed(0)}`);

  // Show first few trades
  for (const t of result.trades.slice(0, 5)) {
    console.log(`  Trade: ${t.direction} entry=${t.entryPrice.toFixed(0)} exit=${t.exitPrice.toFixed(0)} pnl=${t.pnl.toFixed(2)} R=${t.rMultiple.toFixed(2)} bars=${t.exitBarIndex - t.entryBarIndex} comment=${t.entryComment} exitComment=${t.exitComment}`);
  }
}
