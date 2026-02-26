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

import { isMainModule } from "@trading/shared";
import {
  CandleCache,
  runBacktest,
  computeMetrics,
  analyzeTradeList,
  DEFAULT_BACKTEST_CONFIG,
  createDonchianAdx,
  createKeltnerRsi2,
} from "@trading/backtest";
import type { CandleInterval, DataSource, Strategy } from "@trading/backtest";

interface ChildInput {
  factoryName: string;
  paramOverrides: Record<string, number>;
  dbPath: string;
  coin: string;
  source: string;
  interval: CandleInterval;
  startTime: number;
  endTime: number;
}

const FACTORIES: Record<string, (overrides?: Partial<Record<string, number>>) => Strategy> = {
  createDonchianAdx,
  createKeltnerRsi2,
};

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChildInput;

  const factory = FACTORIES[input.factoryName];
  if (!factory) {
    throw new Error(`Unknown factory: ${input.factoryName}`);
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

    const result = runBacktest(candles, strategy, DEFAULT_BACKTEST_CONFIG, input.interval);
    const metrics = computeMetrics(result.trades, result.maxDrawdownPct);
    const analysis = analyzeTradeList(result.trades);

    process.stdout.write(JSON.stringify({ metrics, analysis, trades: result.trades }));
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
