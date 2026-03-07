import path from "node:path";
import { z } from "zod";
import { execaSync } from "execa";
import type {
  CandleInterval,
  Metrics,
  TradeAnalysis,
  CompletedTrade,
} from "@breaker/backtest";
import { safeJsonParse } from "../../lib/safe-json.js";

interface EngineResult {
  metrics: Metrics;
  analysis: TradeAnalysis;
  trades: CompletedTrade[];
  paramCount?: number;
  strategyParams?: Record<string, unknown>;
}

/**
 * Run backtest in a child process (restructure phase -- after code edit + rebuild, ~5s).
 * Spawns run-engine-child.ts which dynamically imports the freshly compiled strategy.
 */
export function runEngineChild(opts: {
  repoRoot: string;
  factoryName: string;
  /** Compiled .js path for dynamic import (variant strategies). */
  strategyFilePath?: string;
  paramOverrides?: Record<string, number>;
  dbPath: string;
  coin: string;
  source: string;
  interval: CandleInterval;
  startTime: number;
  endTime: number;
  warmupBars?: number;
}): EngineResult {
  const { repoRoot, factoryName, strategyFilePath, paramOverrides, dbPath, coin, source, interval, startTime, endTime, warmupBars = 0 } = opts;

  const childScript = path.join(repoRoot, "dist/loop/stages/run-engine-child.js");

  const input = JSON.stringify({
    factoryName,
    strategyFilePath,
    paramOverrides: paramOverrides ?? {},
    dbPath,
    coin,
    source,
    interval,
    startTime,
    endTime,
    warmupBars,
  });

  let stdout: string;
  let stderr: string;
  try {
    const result = execaSync("node", [childScript], {
      cwd: repoRoot,
      timeout: 30000,
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    // 2a: Include stderr in error message for visibility
    const execErr = err as { stderr?: string; message?: string };
    const stderrContent = execErr.stderr?.trim();
    const errMsg = stderrContent
      ? `Child-process backtest failed: ${execErr.message}\nstderr: ${stderrContent.slice(0, 500)}`
      : `Child-process backtest failed: ${execErr.message}`;
    throw new Error(errMsg);
  }

  // 2a: Warn if stderr has content even on success
  if (stderr?.trim()) {
    console.log(`\x1b[33m[spawn-engine-child] stderr (success): ${stderr.trim().slice(0, 300)}\x1b[0m`);
  }

  const engineResultSchema = z.object({
    metrics: z.object({}).passthrough(),
    analysis: z.object({}).passthrough(),
    trades: z.array(z.object({}).passthrough()),
    paramCount: z.number().optional(),
    strategyParams: z.record(z.unknown()).optional(),
  }).passthrough();

  const result = safeJsonParse<EngineResult>(stdout, { repair: true, schema: engineResultSchema as unknown as z.ZodType<EngineResult> });
  return result;
}
