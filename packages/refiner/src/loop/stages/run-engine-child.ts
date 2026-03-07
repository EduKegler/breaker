#!/usr/bin/env node
/**
 * run-engine-child.ts — Standalone child process for running backtests.
 *
 * Spawned by runEngineChild() in run-engine.ts.
 * Dynamically imports the freshly compiled strategy (after pnpm build),
 * loads candles from cache (already synced), runs backtest, outputs JSON to stdout.
 *
 * Input: JSON on stdin with { factoryName, paramOverrides, dbPath, coin, source, interval, startTime, endTime }
 * Output: JSON on stdout with { metrics, analysis, trades }
 */

import { isMainModule } from "@breaker/kit";
import {
  CandleCache,
  runBacktest,
  computeMetrics,
  analyzeTradeList,
  DEFAULT_BACKTEST_CONFIG,
  createDonchianAdx,
} from "@breaker/backtest";
import type { CandleInterval, DataSource, Strategy } from "@breaker/backtest";

interface ChildInput {
  factoryName: string;
  /** Absolute path to compiled .js file for dynamic import (variant strategies). */
  strategyFilePath?: string;
  paramOverrides: Record<string, number>;
  dbPath: string;
  coin: string;
  source: string;
  interval: CandleInterval;
  startTime: number;
  endTime: number;
  warmupBars?: number;
}

const FACTORIES: Record<string, (overrides?: Partial<Record<string, number>>) => Strategy> = {
  createDonchianAdx,
};

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildInput;

  let factory: (overrides?: Partial<Record<string, number>>) => Strategy;

  if (input.strategyFilePath) {
    // Dynamic import for variant strategy files
    const mod = await import(input.strategyFilePath) as Record<string, unknown>;
    const key = Object.keys(mod).find(
      (k) => typeof mod[k] === "function" && k.startsWith("create"),
    );
    if (!key) {
      throw new Error(
        `No create* factory found in ${input.strategyFilePath}`,
      );
    }
    factory = mod[key] as typeof factory;
  } else {
    const registered = FACTORIES[input.factoryName];
    if (!registered) {
      throw new Error(`Unknown factory: ${input.factoryName}`);
    }
    factory = registered;
  }

  const strategy = factory(input.paramOverrides);

  const cache = new CandleCache(input.dbPath);
  try {
    const candles = cache.getCandles(
      input.coin,
      input.interval,
      input.startTime,
      input.endTime,
      input.source as DataSource,
    );

    if (candles.length === 0) {
      throw new Error(`No candles in cache for ${input.coin}/${input.interval}`);
    }

    const config = { ...DEFAULT_BACKTEST_CONFIG, warmupBars: input.warmupBars ?? 0 };
    const result = runBacktest(candles, strategy, config, input.interval);
    const metrics = computeMetrics(result.trades, result.maxDrawdownPct);
    const analysis = analyzeTradeList(result.trades);

    // B3: Include paramCount from the freshly-loaded strategy (ESM cache is clean in child process)
    const paramCount = Object.values(strategy.params).filter((p) => p.optimizable !== false).length;

    process.stdout.write(JSON.stringify({ metrics, analysis, trades: result.trades, paramCount, strategyParams: strategy.params }));
  } finally {
    cache.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`run-engine-child error: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
