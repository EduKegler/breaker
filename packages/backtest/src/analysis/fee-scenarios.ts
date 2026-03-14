import type { Candle, CandleInterval } from "../types/candle.js";
import type { Strategy } from "../types/strategy.js";
import type { BacktestConfig } from "../engine/engine.js";
import type { CostScenarioResult } from "./run-cost-scenarios.js";
import { runCostScenarios } from "./run-cost-scenarios.js";

export interface FeeScenario {
  label: string;
  commissionPct: number; // per side
}

export type FeeScenarioResult = CostScenarioResult<FeeScenario>;

export const DEFAULT_FEE_SCENARIOS: FeeScenario[] = [
  { label: "maker+maker", commissionPct: 0.015 },
  { label: "maker+taker", commissionPct: 0.030 },
  { label: "taker+taker", commissionPct: 0.045 },
];

export function runFeeScenarios(
  candles: Candle[],
  strategy: Strategy,
  baseConfig: BacktestConfig,
  interval: CandleInterval,
  scenarios: FeeScenario[] = DEFAULT_FEE_SCENARIOS,
): FeeScenarioResult[] {
  const baseCommission = baseConfig.execution.commissionPct;

  return runCostScenarios(
    candles, strategy, baseConfig, interval, scenarios,
    (config, scenario) => ({
      ...config,
      execution: { ...config.execution, commissionPct: scenario.commissionPct },
    }),
    (s) => s.commissionPct === baseCommission || s.label === "taker+taker",
  );
}
