import fs from "node:fs";
import path from "node:path";
import type { CheckpointData } from "../types.js";
import type { Metrics } from "@trading/backtest";

/**
 * Save a checkpoint (best strategy source + params + metrics).
 */
export function saveCheckpoint(
  checkpointDir: string,
  strategyContent: string,
  metrics: Metrics,
  iter: number,
  params?: Record<string, number>,
): void {
  if (!fs.existsSync(checkpointDir)) {
    fs.mkdirSync(checkpointDir, { recursive: true });
  }

  const strategyPath = path.join(checkpointDir, "best-strategy.ts");
  const metricsPath = path.join(checkpointDir, "best-metrics.json");
  const paramsPath = path.join(checkpointDir, "best-params.json");

  fs.writeFileSync(strategyPath + ".tmp", strategyContent, "utf8");
  fs.writeFileSync(
    metricsPath + ".tmp",
    JSON.stringify({ ...metrics, iter, timestamp: new Date().toISOString() }, null, 2),
    "utf8",
  );

  fs.renameSync(strategyPath + ".tmp", strategyPath);
  fs.renameSync(metricsPath + ".tmp", metricsPath);

  if (params) {
    fs.writeFileSync(paramsPath + ".tmp", JSON.stringify(params, null, 2), "utf8");
    fs.renameSync(paramsPath + ".tmp", paramsPath);
  }
}

/**
 * Load a saved checkpoint. Returns null if none exists.
 */
export function loadCheckpoint(checkpointDir: string): CheckpointData | null {
  const strategyPath = path.join(checkpointDir, "best-strategy.ts");
  const metricsPath = path.join(checkpointDir, "best-metrics.json");

  // Fall back to legacy best.pine if new file doesn't exist
  const legacyPath = path.join(checkpointDir, "best.pine");
  const actualStrategyPath = fs.existsSync(strategyPath) ? strategyPath : legacyPath;

  if (!fs.existsSync(actualStrategyPath) || !fs.existsSync(metricsPath)) {
    return null;
  }

  try {
    const strategyContent = fs.readFileSync(actualStrategyPath, "utf8");
    const raw = JSON.parse(fs.readFileSync(metricsPath, "utf8")) as {
      iter?: number;
      timestamp?: string;
    } & Metrics;

    let params: Record<string, number> | undefined;
    const paramsPath = path.join(checkpointDir, "best-params.json");
    if (fs.existsSync(paramsPath)) {
      try {
        params = JSON.parse(fs.readFileSync(paramsPath, "utf8")) as Record<string, number>;
      } catch { /* ignore corrupt params */ }
    }

    return {
      strategyContent,
      metrics: {
        totalPnl: raw.totalPnl,
        numTrades: raw.numTrades,
        profitFactor: raw.profitFactor,
        maxDrawdownPct: raw.maxDrawdownPct,
        winRate: raw.winRate,
        avgR: raw.avgR,
      },
      params,
      iter: raw.iter ?? 0,
      timestamp: raw.timestamp ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Rollback the strategy source to the checkpoint version.
 * For refine phase: restores params only. For restructure: restores source + rebuilds.
 */
export function rollback(
  checkpointDir: string,
  strategyFile: string,
): boolean {
  const strategyPath = path.join(checkpointDir, "best-strategy.ts");
  const legacyPath = path.join(checkpointDir, "best.pine");
  const actualPath = fs.existsSync(strategyPath) ? strategyPath : legacyPath;

  if (!fs.existsSync(actualPath)) return false;

  const content = fs.readFileSync(actualPath, "utf8");
  fs.writeFileSync(strategyFile, content, "utf8");
  return true;
}

/**
 * Load the saved param overrides from checkpoint.
 */
export function loadCheckpointParams(checkpointDir: string): Record<string, number> | null {
  const paramsPath = path.join(checkpointDir, "best-params.json");
  if (!fs.existsSync(paramsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(paramsPath, "utf8")) as Record<string, number>;
  } catch {
    return null;
  }
}
