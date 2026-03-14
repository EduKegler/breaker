/**
 * Compare V-A (ADX dynamic + DI) and V-C (pullback depth + 2-bar) variants
 * against ULTRA baseline. Includes cost stress grid.
 * Usage: tsx src/scripts/compare-pullback-variants.ts [days]
 */
import { CandleCache } from "../data/candle-cache.js";
import type { CandleClientOptions } from "../data/fetch-candles.js";
import { runBacktest, DEFAULT_BACKTEST_CONFIG } from "../engine/engine.js";
import { computeMetrics } from "../analysis/metrics-calculator.js";
import { computeRiskMetrics } from "../analysis/compute-risk-metrics.js";
import { createEmaVwapAtrPullback } from "../strategies/btc/pullback/ema-vwap-atr-pullback.js";
import type { Strategy } from "../types/strategy.js";
import type { Candle } from "../types/candle.js";
import type { BacktestConfig } from "../engine/engine.js";
import path from "node:path";
import fs from "node:fs";
import { isMainModule } from "@breaker/kit";

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

interface VariantConfig {
  label: string;
  overrides: Record<string, number>;
}

function runVariant(
  label: string,
  strategy: Strategy,
  candles: Candle[],
  config: BacktestConfig,
  days: number,
  interval: "15m" | "1h" | "4h" | "1d",
): string {
  const result = runBacktest(candles, strategy, config, interval);
  const trades = result.trades;
  const rawMetrics = computeMetrics(trades, result.maxDrawdownPct, days, config.initialCapital);
  const riskMetrics = computeRiskMetrics(result.equityPoints);
  const m = { ...rawMetrics, ...riskMetrics };

  const longCount = trades.filter(t => t.direction === "long").length;
  const shortCount = trades.filter(t => t.direction === "short").length;

  return (
    label.padEnd(20) +
    String(m.numTrades ?? 0).padStart(7) +
    (m.tradesPerDay?.toFixed(2) ?? "?").padStart(7) +
    (m.winRate?.toFixed(1) ?? "?").padStart(6) +
    (m.profitFactor?.toFixed(2) ?? "?").padStart(7) +
    `$${(m.totalPnl ?? 0).toFixed(0)}`.padStart(10) +
    (m.maxDrawdownPct?.toFixed(1) ?? "?").padStart(7) +
    `${(m.edgeBpsNet ?? 0).toFixed(1)}`.padStart(9) +
    (m.avgR?.toFixed(2) ?? "?").padStart(7) +
    (m.sharpeRatio?.toFixed(2) ?? "?").padStart(8) +
    `${longCount}/${shortCount}`.padStart(8)
  );
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 240);
  const coin = "BTC";
  const interval = "15m" as const;
  const source = "binance" as const;
  const WARMUP_DAYS = 730;

  const endTime = Date.now();
  const startTime = endTime - days * 86_400_000;
  const dataStartTime = startTime - WARMUP_DAYS * 86_400_000;

  const cacheDir = path.join(process.cwd(), ".cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cache = new CandleCache(path.join(cacheDir, "candles.db"));

  const clientOpts: CandleClientOptions = { source };
  console.log("Syncing candles...");
  await cache.sync(coin, interval, dataStartTime, endTime, clientOpts);
  for (const tf of ["1h", "1d"] as const) {
    await cache.sync(coin, tf, dataStartTime, endTime, clientOpts);
  }

  const candles = cache.getCandles(coin, interval, dataStartTime, endTime, source);
  cache.close();

  if (candles.length === 0) {
    console.error("No candles.");
    process.exit(1);
  }

  const warmupBars = candles.findIndex(c => c.t >= startTime);
  const effectiveWarmup = warmupBars === -1 ? candles.length : warmupBars;

  const config = {
    ...DEFAULT_BACKTEST_CONFIG,
    warmupBars: effectiveWarmup,
  };

  // ULTRA baseline (best from prior sweep)
  const ultra = {
    adxThreshold: 30, slopeThreshold: 0.7, pullbackBars: 3,
    atrStopMult: 2.5, tp1RR: 1.5, timeoutBars: 30,
  };

  // V-A: ADX dynamic (>23 rising) + DI direction, keep 3-bar pullback
  const vA = {
    adxThreshold: 23, adxRising: 1, useDiDirection: 1,
    slopeThreshold: 0.7, pullbackBars: 3,
    atrStopMult: 2.5, tp1RR: 1.5, timeoutBars: 30,
  };

  // V-C: Pullback depth + 2-bar, ADX>25 + DI
  const vC = {
    adxThreshold: 25, useDiDirection: 1,
    slopeThreshold: 0.3, pullbackBars: 2,
    pullbackDepthMin: 0.6, pullbackDepthMax: 1.6,
    atrStopMult: 2.5, tp1RR: 1.5, timeoutBars: 30,
  };

  const hdr =
    "Variant".padEnd(20) +
    "Trades".padStart(7) +
    "Tr/day".padStart(7) +
    "WR%".padStart(6) +
    "PF".padStart(7) +
    "PnL".padStart(10) +
    "DD%".padStart(7) +
    "Edge(n)".padStart(9) +
    "AvgR".padStart(7) +
    "Sharpe".padStart(8) +
    "L/S".padStart(8);

  // === Section 1: Core variants ===
  console.log(`\n=== Core Variants (${days}d) ===\n`);
  console.log(hdr);
  console.log("─".repeat(96));

  const variants: VariantConfig[] = [
    { label: "ULTRA (baseline)", overrides: ultra },
    { label: "V-A: ADX dyn+DI", overrides: vA },
    { label: "V-C: depth+2bar", overrides: vC },
    // V-A sub-variants
    { label: "V-A adx>20", overrides: { ...vA, adxThreshold: 20 } },
    { label: "V-A adx>25", overrides: { ...vA, adxThreshold: 25 } },
    { label: "V-A slope=0.3", overrides: { ...vA, slopeThreshold: 0.3 } },
    { label: "V-A no-slope", overrides: { ...vA, slopeThreshold: 0 } },
    // V-C sub-variants
    { label: "V-C depth 0.4-2.0", overrides: { ...vC, pullbackDepthMin: 0.4, pullbackDepthMax: 2.0 } },
    { label: "V-C depth 0.8-1.4", overrides: { ...vC, pullbackDepthMin: 0.8, pullbackDepthMax: 1.4 } },
    { label: "V-C no-depth", overrides: { ...vC, pullbackDepthMin: 0, pullbackDepthMax: 0 } },
    { label: "V-C adx>30", overrides: { ...vC, adxThreshold: 30 } },
  ];

  for (const v of variants) {
    const strategy = createEmaVwapAtrPullback(v.overrides);
    console.log(runVariant(v.label, strategy, candles, config, days, interval));
  }

  // === Section 2: Cost stress grid for best variants ===
  console.log(`\n=== Cost Stress Grid ===\n`);
  const stressHdr =
    "Variant × Cost".padEnd(28) +
    "Trades".padStart(7) +
    "PF".padStart(7) +
    "PnL".padStart(10) +
    "Edge(n)".padStart(9);
  console.log(stressHdr);
  console.log("─".repeat(61));

  const bestVariants = [
    { label: "ULTRA", overrides: ultra },
    { label: "V-A", overrides: vA },
    { label: "V-C", overrides: vC },
  ];

  const costScenarios = [
    { label: "maker+maker", commission: 0.015 },
    { label: "maker+taker", commission: 0.030 },
    { label: "taker+taker", commission: 0.045 },
  ];
  const slippageScenarios = [0, 3, 6, 10];

  for (const v of bestVariants) {
    for (const fee of costScenarios) {
      for (const slip of slippageScenarios) {
        const costConfig = {
          ...config,
          execution: { ...config.execution, slippageBps: slip, commissionPct: fee.commission },
        };
        const strategy = createEmaVwapAtrPullback(v.overrides);
        const result = runBacktest(candles, strategy, costConfig, interval);
        const trades = result.trades;
        const m = computeMetrics(trades, result.maxDrawdownPct, days, config.initialCapital);

        const label = `${v.label} ${fee.label} s=${slip}`;
        console.log(
          label.padEnd(28) +
          String(m.numTrades ?? 0).padStart(7) +
          (m.profitFactor?.toFixed(2) ?? "?").padStart(7) +
          `$${(m.totalPnl ?? 0).toFixed(0)}`.padStart(10) +
          `${(m.edgeBpsNet ?? 0).toFixed(1)}`.padStart(9),
        );
      }
    }
    console.log("");
  }

  console.log("Done.");
}
