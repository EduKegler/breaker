import type { Candle, CandleInterval } from "../types/candle.js";
import type { Strategy } from "../types/strategy.js";
import type { BacktestConfig } from "../engine/engine.js";
import type { CostScenarioResult } from "./run-cost-scenarios.js";
import { runCostScenarios } from "./run-cost-scenarios.js";

export interface SlippageScenario {
  label: string;
  slippageBps: number;
}

export type SlippageStressResult = CostScenarioResult<SlippageScenario>;

export const DEFAULT_SCENARIOS: SlippageScenario[] = [
  { label: "optimistic", slippageBps: 1 },
  { label: "base", slippageBps: 3 },
  { label: "conservative", slippageBps: 8 },
  { label: "worst-case", slippageBps: 15 },
];

export function runSlippageStress(
  candles: Candle[],
  strategy: Strategy,
  baseConfig: BacktestConfig,
  interval: CandleInterval,
  scenarios: SlippageScenario[] = DEFAULT_SCENARIOS,
): SlippageStressResult[] {
  const baseSlippage = baseConfig.execution.slippageBps;

  return runCostScenarios(
    candles, strategy, baseConfig, interval, scenarios,
    (config, scenario) => ({
      ...config,
      execution: { ...config.execution, slippageBps: scenario.slippageBps },
    }),
    (s) => s.slippageBps === baseSlippage || s.label === "base",
  );
}
