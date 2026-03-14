import { createDonchianBreakoutPure } from "../strategies/btc/trend-following/donchian-breakout-pure.js";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "../engine/engine.js";
import { computeMetrics } from "../analysis/metrics-calculator.js";
import { computeMinWarmupBars } from "../engine/compute-min-warmup-bars.js";
import { CandleCache } from "../data/candle-cache.js";
import type { Candle } from "../types/candle.js";
import type { CandleInterval } from "../types/candle.js";
import type { CompletedTrade } from "../types/order.js";
import path from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "@breaker/kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bars per day for each timeframe
const BARS_PER_DAY: Record<string, number> = {
  "15m": 96,
  "1h": 24,
  "4h": 6,
  "1d": 1,
};

interface TestResult {
  label: string;
  tf: string;
  entryDays: number;
  exitDays: number;
  trades: number;
  pf: number;
  wr: number;
  dd: number;
  avgR: number;
  pnl: number;
  longs: number;
  shorts: number;
  longWR: string;
  shortWR: string;
}

function test(
  label: string,
  tf: CandleInterval,
  entryDays: number,
  exitDays: number,
  atrStopMult: number,
  candles: Candle[],
  effectiveWarmup: number,
): TestResult {
  const bpd = BARS_PER_DAY[tf] ?? 6;
  const entryBars = entryDays * bpd;
  const exitBars = exitDays * bpd;

  const strategy = createDonchianBreakoutPure({ entryBars, exitBars, atrStopMult });
  const warmupBars = computeMinWarmupBars(strategy, tf);
  const result = runBacktest(
    candles,
    strategy,
    {
      ...DEFAULT_BACKTEST_CONFIG,
      warmupBars: Math.max(warmupBars, effectiveWarmup),
    },
    tf,
  );

  const m = computeMetrics(result.trades, result.maxDrawdownPct);
  const trades = result.trades as CompletedTrade[];
  const longs = trades.filter(t => t.direction === "long");
  const shorts = trades.filter(t => t.direction === "short");
  const longWins = longs.filter(t => t.pnl > 0).length;
  const shortWins = shorts.filter(t => t.pnl > 0).length;
  const longWR = longs.length > 0 ? ((longWins / longs.length) * 100).toFixed(0) : "-";
  const shortWR = shorts.length > 0 ? ((shortWins / shorts.length) * 100).toFixed(0) : "-";

  return {
    label,
    tf,
    entryDays,
    exitDays,
    trades: m.numTrades ?? 0,
    pf: m.profitFactor ?? 0,
    wr: m.winRate ?? 0,
    dd: Math.abs(m.maxDrawdownPct ?? 0),
    avgR: m.avgR ?? 0,
    pnl: m.totalPnl ?? 0,
    longs: longs.length,
    shorts: shorts.length,
    longWR,
    shortWR,
  };
}

function printResult(r: TestResult): void {
  const pfStr = r.pf === Infinity ? "  Inf" : r.pf.toFixed(2).padStart(5);
  const pass =
    r.pf >= 1.4 && r.dd <= 12 && r.trades >= 15 && r.avgR >= 0.2;
  const tag = pass ? " ✓ PASS" : "";

  console.log(
    `  ${r.label.padEnd(22)} E${r.entryDays}d/X${r.exitDays}d  PF=${pfStr}  Trd=${String(r.trades).padStart(4)}  WR=${r.wr.toFixed(0).padStart(3)}%  DD=${r.dd.toFixed(1).padStart(5)}%  AvgR=${r.avgR.toFixed(3).padStart(7)}  PnL=$${r.pnl.toFixed(0).padStart(6)}  L:${r.longs}(${r.longWR}%) S:${r.shorts}(${r.shortWR}%)${tag}`,
  );
}

if (isMainModule(import.meta.url)) {
  const dbPath = path.join(__dirname, "../../.cache/candles.db");
  const cache = new CandleCache(dbPath);
  // Use M4 config date range: 2024-01-01 to 2026-02-24
  const startTime = new Date("2024-01-01T00:00:00Z").getTime();
  const end = new Date("2026-02-24T23:59:59Z").getTime();
  const WARMUP_DAYS = 730;
  const dataStartTime = startTime - WARMUP_DAYS * 86400000;

  const timeframes: CandleInterval[] = ["1d", "1h", "15m"];

  // Day-equivalent lookbacks to test (entry days / exit days)
  const lookbacks: [number, number][] = [
    [20, 10], // QuantPedia original
    [15, 7],
    [10, 5],
    [7, 3],
    [5, 2],
    [30, 15],
    [40, 20],
  ];

  const atrStopMults = [2.0, 3.0, 4.0];

  for (const tf of timeframes) {
    console.log(`\nSyncing ${tf} candles...`);
    await cache.sync("BTC", tf, dataStartTime, end);

    const candles = cache.getCandles("BTC", tf, dataStartTime, end, "binance");
    if (candles.length === 0) {
      console.error(`  No ${tf} candles found`);
      continue;
    }

    const effectiveWarmup = candles.findIndex(c => c.t >= startTime);
    const ewFinal = effectiveWarmup < 0 ? 200 : effectiveWarmup;

    console.log(
      `  Candles: ${candles.length} (${new Date(candles[0].t).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].t).toISOString().slice(0, 10)})`,
    );
    console.log(`  Effective warmup: ${ewFinal} bars`);

    console.log(`\n=== ${tf.toUpperCase()} — LOOKBACK SWEEP (ATR stop = 3.0) ===`);
    const results = lookbacks.map(([ed, xd]) =>
      test(`${tf} ${ed}d/${xd}d`, tf, ed, xd, 3.0, candles, ewFinal),
    );
    for (const r of results) printResult(r);

    // Find best lookback, then sweep stop multiplier
    const best = results
      .filter(r => r.trades >= 10)
      .sort((a, b) => b.pf - a.pf)[0];

    if (best) {
      console.log(
        `\n=== ${tf.toUpperCase()} — ATR STOP SWEEP (best lookback: E${best.entryDays}d/X${best.exitDays}d) ===`,
      );
      for (const mult of atrStopMults) {
        const r = test(
          `${tf} stop=${mult}`,
          tf,
          best.entryDays,
          best.exitDays,
          mult,
          candles,
          ewFinal,
        );
        printResult(r);
      }
    }
  }

  // Also sync 1d for higher-timeframe ATR (needed by strategy)
  await cache.sync("BTC", "1d", dataStartTime, end);

  cache.close();

  console.log("\n=== CRITERIA: PF≥1.4  DD≤12%  Trades≥15  AvgR≥0.2 ===");
}
