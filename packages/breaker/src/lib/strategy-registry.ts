import { createDonchianAdx, createKeltnerRsi2 } from "@trading/backtest";
import type { Strategy } from "@trading/backtest";

type StrategyFactory = (paramOverrides?: Partial<Record<string, number>>) => Strategy;

const REGISTRY: Record<string, StrategyFactory> = {
  createDonchianAdx,
  createKeltnerRsi2,
};

/**
 * Look up a strategy factory by config name.
 * Throws if the name is not registered.
 */
export function getStrategyFactory(name: string): StrategyFactory {
  const factory = REGISTRY[name];
  if (!factory) {
    const available = Object.keys(REGISTRY).join(", ");
    throw new Error(`Unknown strategy factory "${name}". Available: ${available}`);
  }
  return factory;
}

/**
 * List all registered strategy factory names.
 */
export function listStrategyFactories(): string[] {
  return Object.keys(REGISTRY);
}
