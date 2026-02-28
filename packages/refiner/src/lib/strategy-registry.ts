import { createDonchianAdx, createKeltnerRsi2 } from "@breaker/backtest";
import type { Strategy } from "@breaker/backtest";

type StrategyFactory = (paramOverrides?: Partial<Record<string, number>>) => Strategy;

const REGISTRY: Record<string, StrategyFactory> = {
  createDonchianAdx,
  createKeltnerRsi2,
};

/**
 * Registry of strategy factories.
 * Maps config names to backtest factory functions.
 */
export const strategyRegistry = {
  /**
   * Look up a strategy factory by config name.
   * Throws if the name is not registered.
   */
  get(name: string): StrategyFactory {
    const factory = REGISTRY[name];
    if (!factory) {
      const available = Object.keys(REGISTRY).join(", ");
      throw new Error(`Unknown strategy factory "${name}". Available: ${available}`);
    }
    return factory;
  },

  /**
   * List all registered strategy factory names.
   */
  list(): string[] {
    return Object.keys(REGISTRY);
  },
};
