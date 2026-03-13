import type { CandleInterval } from "@breaker/backtest";
import type { ExchangeConfig, ModuleType } from "../types/config.js";
import type { DeployedStrategyEntry } from "@breaker/backtest/deployed";

/** Strategy resolved from deployedManifest + config overrides. */
export interface EffectiveStrategy {
  coin: string;
  name: string;
  interval: CandleInterval;
  moduleType: ModuleType;
  leverage: number;
  autoTradingEnabled: boolean;
}

/**
 * Build the effective strategy list from the deployed manifest.
 *
 * For each coin in config, filters the manifest to find deployed strategies
 * for that coin and applies `strategyOverrides` (e.g. autoTradingEnabled).
 *
 * The manifest is the single source of truth — only strategies that have been
 * promoted to `deployed/` are eligible. Config only provides per-coin settings
 * (leverage) and per-strategy overrides.
 */
export function resolveEffectiveStrategies(
  config: ExchangeConfig,
  manifest: DeployedStrategyEntry[],
): EffectiveStrategy[] {
  const result: EffectiveStrategy[] = [];

  for (const coinCfg of config.coins) {
    const coinEntries = manifest.filter(e => e.coin === coinCfg.coin);
    for (const entry of coinEntries) {
      const override = config.strategyOverrides[entry.strategyName];
      result.push({
        coin: coinCfg.coin,
        name: entry.strategyName,
        interval: entry.interval as CandleInterval,
        moduleType: entry.moduleType as ModuleType,
        leverage: coinCfg.leverage,
        autoTradingEnabled: override?.autoTradingEnabled ?? false,
      });
    }
  }

  return result;
}
