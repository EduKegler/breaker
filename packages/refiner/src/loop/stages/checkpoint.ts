import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import type { CheckpointData } from "../types.js";
import type { Metrics, CompletedTrade, StrategyParam } from "@breaker/backtest";
import { safeJsonParse } from "../../lib/safe-json.js";

/**
 * Checkpoint operations for saving/loading best strategy state.
 * Consolidated into a single object to comply with one-export-per-file.
 */
export const checkpoint = {
  /**
   * Save a checkpoint (best strategy source + params + metrics).
   */
  save(
    checkpointDir: string,
    strategyContent: string,
    metrics: Metrics,
    iter: number,
    params?: Record<string, number>,
    trades?: CompletedTrade[],
    paramCount?: number,
    strategyParams?: Record<string, StrategyParam>,
  ): void {
    const strategyPath = path.join(checkpointDir, "best-strategy.ts.bak");
    const metricsPath = path.join(checkpointDir, "best-metrics.json");
    const paramsPath = path.join(checkpointDir, "best-params.json");

    // Write all checkpoint files. If any write fails (e.g. disk full),
    // catch and re-throw with context so the caller knows the checkpoint is partial.
    try {
      if (!fs.existsSync(checkpointDir)) {
        fs.mkdirSync(checkpointDir, { recursive: true });
      }
      writeFileAtomic.sync(strategyPath, strategyContent, "utf8");
      writeFileAtomic.sync(
        metricsPath,
        JSON.stringify({
          ...metrics,
          iter,
          timestamp: new Date().toISOString(),
          ...(paramCount != null ? { paramCount } : {}),
          ...(strategyParams != null ? { strategyParams } : {}),
        }, null, 2),
        "utf8",
      );

      if (params) {
        writeFileAtomic.sync(paramsPath, JSON.stringify(params, null, 2), "utf8");
      }

      if (trades && trades.length > 0) {
        const csvHeader = "direction,entryPrice,exitPrice,pnl,rMultiple,entryTimestamp,exitTimestamp,barsHeld,exitType,entryComment";
        const csvRows = trades.map((t) =>
          [
            t.direction,
            t.entryPrice,
            t.exitPrice,
            t.pnl,
            t.rMultiple,
            new Date(t.entryTimestamp).toISOString(),
            new Date(t.exitTimestamp).toISOString(),
            t.barsHeld,
            t.exitType,
            `"${(t.entryComment || "").replace(/"/g, '""')}"`,
          ].join(","),
        );
        const csvPath = path.join(checkpointDir, "best-trades.csv");
        writeFileAtomic.sync(csvPath, [csvHeader, ...csvRows].join("\n") + "\n", "utf8");
      }
    } catch (err) {
      throw new Error(`Checkpoint save failed (partial state possible): ${(err as Error).message}`);
    }
  },

  /**
   * Load a saved checkpoint. Returns null if none exists.
   */
  load(checkpointDir: string): CheckpointData | null {
    const strategyPath = path.join(checkpointDir, "best-strategy.ts.bak");
    const metricsPath = path.join(checkpointDir, "best-metrics.json");

    if (!fs.existsSync(strategyPath) || !fs.existsSync(metricsPath)) {
      return null;
    }

    const metricsSchema = z.object({
      totalPnl: z.number().nullable().optional(),
      numTrades: z.number().nullable().optional(),
      profitFactor: z.number().nullable().optional(),
      maxDrawdownPct: z.number().nullable().optional(),
      winRate: z.number().nullable().optional(),
      avgR: z.number().nullable().optional(),
      avgWinR: z.number().nullable().optional(),
      avgLossR: z.number().nullable().optional(),
      maxLossR: z.number().nullable().optional(),
      expectancy: z.number().nullable().optional(),
      iter: z.number().optional(),
      timestamp: z.string().optional(),
      paramCount: z.number().optional(),
      strategyParams: z.record(z.string(), z.object({
        value: z.number(),
        min: z.number(),
        max: z.number(),
        step: z.number(),
        optimizable: z.boolean(),
        description: z.string().optional(),
      })).optional(),
    }).passthrough();

    try {
      const strategyContent = fs.readFileSync(strategyPath, "utf8");
      const raw = safeJsonParse(fs.readFileSync(metricsPath, "utf8"), { schema: metricsSchema });

      let params: Record<string, number> | undefined;
      const paramsPath = path.join(checkpointDir, "best-params.json");
      if (fs.existsSync(paramsPath)) {
        try {
          params = safeJsonParse(fs.readFileSync(paramsPath, "utf8"), {
            schema: z.record(z.string(), z.number()),
          });
        } catch { /* ignore corrupt params */ }
      }

      return {
        strategyContent,
        metrics: {
          totalPnl: raw.totalPnl ?? null,
          numTrades: raw.numTrades ?? null,
          profitFactor: raw.profitFactor ?? null,
          maxDrawdownPct: raw.maxDrawdownPct ?? null,
          winRate: raw.winRate ?? null,
          avgR: raw.avgR ?? null,
          avgWinR: raw.avgWinR ?? null,
          avgLossR: raw.avgLossR ?? null,
          maxLossR: raw.maxLossR ?? null,
          expectancy: raw.expectancy ?? null,
        },
        params,
        paramCount: raw.paramCount,
        strategyParams: raw.strategyParams as Record<string, StrategyParam> | undefined,
        iter: raw.iter ?? 0,
        timestamp: raw.timestamp ?? "",
      };
    } catch {
      return null;
    }
  },

  /**
   * Rollback the strategy source to the checkpoint version.
   * For refine phase: restores params only. For restructure: restores source + rebuilds.
   */
  rollback(
    checkpointDir: string,
    strategyFile: string,
  ): boolean {
    const strategyPath = path.join(checkpointDir, "best-strategy.ts.bak");

    if (!fs.existsSync(strategyPath)) return false;

    const content = fs.readFileSync(strategyPath, "utf8");
    writeFileAtomic.sync(strategyFile, content, "utf8");
    return true;
  },

  /**
   * Load the saved param overrides from checkpoint.
   */
  loadParams(checkpointDir: string): Record<string, number> | null {
    const paramsPath = path.join(checkpointDir, "best-params.json");
    if (!fs.existsSync(paramsPath)) return null;
    try {
      return safeJsonParse(fs.readFileSync(paramsPath, "utf8"), {
        schema: z.record(z.string(), z.number()),
      });
    } catch {
      return null;
    }
  },
};
