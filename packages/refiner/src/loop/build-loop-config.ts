import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../lib/config.js";
import { buildStrategyDir } from "../lib/build-strategy-dir.js";
import type { DataSource, CandleInterval } from "@breaker/backtest";
import type { LoopConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Build a fully-resolved LoopConfig from partial CLI/env inputs.
 */
export function buildLoopConfig(partial: Partial<LoopConfig>): LoopConfig {
  const repoRoot = partial.repoRoot || DEFAULT_REPO_ROOT;
  const asset = partial.asset || "BTC";
  const strategy = partial.strategy || "breakout";
  const configFile = path.join(repoRoot, "breaker-config.json");
  const { config, criteria, dataConfig, dateRange } = loadConfig(configFile, { asset, strategy });
  const { startTime, endTime } = dateRange;
  const strategyDir = buildStrategyDir(repoRoot, asset, strategy);
  const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/(\d{8})(\d{6})/, "$1_$2");

  return {
    asset,
    strategy,
    maxIter: partial.maxIter || 10,
    maxFixAttempts: parseInt(process.env.MAX_FIX_ATTEMPTS || "3"),
    maxTransientFailures: parseInt(process.env.MAX_TRANSIENT_FAILURES || "3"),
    maxNoChange: parseInt(process.env.MAX_NO_CHANGE || "2"),
    autoCommit: partial.autoCommit || false,
    criteria,
    modelRouting: config.modelRouting,
    guardrails: config.guardrails,
    phases: config.phases,
    scoring: config.scoring,
    research: config.research,
    coin: dataConfig.coin,
    dataSource: dataConfig.dataSource as DataSource,
    interval: dataConfig.interval as CandleInterval,
    strategyFactory: dataConfig.strategyFactory,
    startTime,
    endTime,
    dbPath: path.join(repoRoot, "candles.db"),
    repoRoot,
    strategyDir,
    strategyFile: "", // resolved in orchestrate() via getStrategySourcePath
    configFile,
    paramHistoryFile: path.join(strategyDir, "parameter-history.json"),
    checkpointDir: path.join(strategyDir, "checkpoints"),
    artifactsDir: path.join(repoRoot, "artifacts", runId),
    runId,
  };
}
