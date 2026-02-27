import fs from "node:fs";
import { BreakerConfigSchema } from "../types/config.js";
import type { BreakerConfig, ResolvedCriteria, StrategyDateRange } from "../types/config.js";

/**
 * Loads and validates breaker-config.json using Zod.
 * Returns a fully-typed BreakerConfig with defaults applied for missing fields.
 */
export function loadConfig(configPath: string): BreakerConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  const json: unknown = JSON.parse(raw);
  return BreakerConfigSchema.parse(json);
}

/**
 * Resolves effective criteria for an asset by merging:
 * 1. Global criteria (base)
 * 2. Asset class overrides (class wins over global)
 * 3. Strategy profile overrides (strategy wins over class)
 */
export function resolveAssetCriteria(
  config: BreakerConfig,
  asset: string,
  strategy?: string,
): ResolvedCriteria {
  const assetCfg = config.assets[asset];
  const assetClass = assetCfg?.class;
  const classCriteria = assetClass
    ? (config.assetClasses[assetClass] ?? {})
    : {};

  let profileName: string | undefined;
  if (strategy && assetCfg?.strategies[strategy]) {
    profileName = assetCfg.strategies[strategy].profile ?? strategy;
  } else if (assetCfg?.strategy) {
    profileName = assetCfg.strategy;
  }

  const strategyProfile = profileName
    ? (config.strategyProfiles[profileName] ?? {})
    : {};
  return { ...config.criteria, ...classCriteria, ...strategyProfile };
}

interface DataConfig {
  coin: string;
  dataSource: string;
  interval: string;
  strategyFactory: string;
}

/**
 * Resolves the data configuration for an asset+strategy pair.
 * Returns coin, dataSource, interval, and strategyFactory from the nested strategy config.
 */
export function resolveDataConfig(
  config: BreakerConfig,
  asset: string,
  strategy?: string,
): DataConfig {
  const assetCfg = config.assets[asset];
  const entry = strategy ? assetCfg?.strategies[strategy] : undefined;

  return {
    coin: entry?.coin ?? asset,
    dataSource: entry?.dataSource ?? "binance",
    interval: entry?.interval ?? "15m",
    strategyFactory: entry?.strategyFactory ?? "createDonchianAdx",
  };
}

/**
 * Resolves the date range for an asset+strategy pair.
 * Returns { startTime, endTime } as epoch ms.
 */
export function resolveDateRange(
  config: BreakerConfig,
  asset: string,
  strategy?: string,
): { startTime: number; endTime: number } {
  const assetCfg = config.assets[asset];
  const rawRange = strategy && assetCfg?.strategies[strategy]?.dateRange
    ? assetCfg.strategies[strategy].dateRange
    : config.dateRange;

  // Object format: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
  if (typeof rawRange === "object" && rawRange !== null && "start" in rawRange) {
    const dr = rawRange as StrategyDateRange;
    return {
      startTime: new Date(dr.start + "T00:00:00Z").getTime(),
      endTime: new Date(dr.end + "T23:59:59.999Z").getTime(),
    };
  }

  // Legacy string format: "custom:YYYY-MM-DD:YYYY-MM-DD" or "lastN"
  const str = rawRange as string;
  const customMatch = str.match(/^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/);
  if (customMatch) {
    return {
      startTime: new Date(customMatch[1] + "T00:00:00Z").getTime(),
      endTime: new Date(customMatch[2] + "T23:59:59.999Z").getTime(),
    };
  }

  // lastN format
  const endTime = Date.now();
  const daysMatch = str.match(/^last(\d+)$/);
  const days = daysMatch ? parseInt(daysMatch[1]) : 365;
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  return { startTime, endTime };
}
