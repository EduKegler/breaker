import path from "node:path";
import { execaSync } from "execa";
import type {
  CandleInterval,
  Metrics,
  TradeAnalysis,
  CompletedTrade,
} from "@breaker/backtest";

interface EngineResult {
  metrics: Metrics;
  analysis: TradeAnalysis;
  trades: CompletedTrade[];
}

/**
 * Run backtest in a child process (restructure phase -- after code edit + rebuild, ~5s).
 * Spawns run-engine-child.ts which dynamically imports the freshly compiled strategy.
 */
export function runEngineChild(opts: {
  repoRoot: string;
  factoryName: string;
  paramOverrides?: Record<string, number>;
  dbPath: string;
  coin: string;
  source: string;
  interval: CandleInterval;
  startTime: number;
  endTime: number;
}): EngineResult {
  const { repoRoot, factoryName, paramOverrides, dbPath, coin, source, interval, startTime, endTime } = opts;

  const childScript = path.join(repoRoot, "dist/loop/stages/run-engine-child.js");

  const input = JSON.stringify({
    factoryName,
    paramOverrides: paramOverrides ?? {},
    dbPath,
    coin,
    source,
    interval,
    startTime,
    endTime,
  });

  const { stdout } = execaSync("node", [childScript], {
    cwd: repoRoot,
    timeout: 30000,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const result = JSON.parse(stdout) as EngineResult;
  return result;
}
