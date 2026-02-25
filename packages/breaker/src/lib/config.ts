import fs from "node:fs";
import { BreakerConfigSchema } from "../types/config.js";
import type { BreakerConfig, ResolvedCriteria } from "../types/config.js";

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
 *
 * When `strategy` is provided, looks up the profile via:
 *   asset.strategies[strategy].profile ?? strategy
 * Falls back to legacy asset.strategy field if no nested match.
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

  // Determine strategy profile name
  let profileName: string | undefined;
  if (strategy && assetCfg?.strategies[strategy]) {
    profileName = assetCfg.strategies[strategy].profile ?? strategy;
  } else if (assetCfg?.strategy) {
    // Legacy flat field
    profileName = assetCfg.strategy;
  }

  const strategyProfile = profileName
    ? (config.strategyProfiles[profileName] ?? {})
    : {};
  return { ...config.criteria, ...classCriteria, ...strategyProfile };
}

/**
 * Resolves the date range for an asset+strategy pair.
 * Looks up nested strategies first, falls back to global dateRange, then "last365".
 */
export function resolveDateRange(
  config: BreakerConfig,
  asset: string,
  strategy?: string,
): string {
  const assetCfg = config.assets[asset];
  if (strategy && assetCfg?.strategies[strategy]?.dateRange) {
    return assetCfg.strategies[strategy].dateRange!;
  }
  return config.dateRange;
}

/**
 * Resolves the TradingView chart URL for an asset+strategy pair.
 * Looks up nested strategies first, falls back to legacy flat chartUrl.
 */
export function resolveChartUrl(
  config: BreakerConfig,
  asset: string,
  strategy?: string,
): string {
  const assetCfg = config.assets[asset];
  if (!assetCfg) return "";

  // Nested strategy entry
  if (strategy && assetCfg.strategies[strategy]?.chartUrl) {
    return assetCfg.strategies[strategy].chartUrl;
  }

  // Legacy flat chartUrl
  return assetCfg.chartUrl ?? "";
}
