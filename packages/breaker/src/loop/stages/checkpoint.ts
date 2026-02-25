import fs from "node:fs";
import path from "node:path";
import type { CheckpointData } from "../types.js";
import type { Metrics } from "../../types/parse-results.js";

/**
 * Save a checkpoint (best strategy + metrics) for an asset.
 */
export function saveCheckpoint(
  checkpointDir: string,
  pineContent: string,
  metrics: Metrics,
  iter: number,
): void {
  if (!fs.existsSync(checkpointDir)) {
    fs.mkdirSync(checkpointDir, { recursive: true });
  }

  const pinePath = path.join(checkpointDir, "best.pine");
  const metricsPath = path.join(checkpointDir, "best-metrics.json");

  fs.writeFileSync(pinePath + ".tmp", pineContent, "utf8");
  fs.writeFileSync(
    metricsPath + ".tmp",
    JSON.stringify({ ...metrics, iter, timestamp: new Date().toISOString() }, null, 2),
    "utf8",
  );

  fs.renameSync(pinePath + ".tmp", pinePath);
  fs.renameSync(metricsPath + ".tmp", metricsPath);
}

/**
 * Load a saved checkpoint. Returns null if none exists.
 */
export function loadCheckpoint(checkpointDir: string): CheckpointData | null {
  const pinePath = path.join(checkpointDir, "best.pine");
  const metricsPath = path.join(checkpointDir, "best-metrics.json");

  if (!fs.existsSync(pinePath) || !fs.existsSync(metricsPath)) {
    return null;
  }

  try {
    const pineContent = fs.readFileSync(pinePath, "utf8");
    const raw = JSON.parse(fs.readFileSync(metricsPath, "utf8")) as {
      iter?: number;
      timestamp?: string;
    } & Metrics;
    return {
      pineContent,
      metrics: {
        totalPnl: raw.totalPnl,
        numTrades: raw.numTrades,
        profitFactor: raw.profitFactor,
        maxDrawdownPct: raw.maxDrawdownPct,
        winRate: raw.winRate,
        avgR: raw.avgR,
      },
      iter: raw.iter ?? 0,
      timestamp: raw.timestamp ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Rollback the strategy file to the checkpoint version.
 */
export function rollback(
  checkpointDir: string,
  strategyFile: string,
): boolean {
  const pinePath = path.join(checkpointDir, "best.pine");
  if (!fs.existsSync(pinePath)) return false;

  const content = fs.readFileSync(pinePath, "utf8");
  fs.writeFileSync(strategyFile, content, "utf8");
  return true;
}
