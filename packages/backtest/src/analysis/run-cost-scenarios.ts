import type { Candle, CandleInterval } from "../types/candle.js";
import type { Strategy } from "../types/strategy.js";
import type { BacktestConfig } from "../engine/engine.js";
import type { Metrics } from "../types/metrics.js";
import { runBacktest } from "../engine/engine.js";
import { computeMetrics } from "./metrics-calculator.js";
import { computeRiskMetrics } from "./compute-risk-metrics.js";

export interface DeltaVsBase {
  pnlDelta: number;
  pfDelta: number;
  edgeBpsNetDelta: number;
}

export interface CostScenarioResult<S extends { label: string }> {
  scenario: S;
  metrics: Metrics;
  deltaVsBase: DeltaVsBase;
}

export function tradingDaysFromCandles(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  return (candles[candles.length - 1].t - candles[0].t) / 86_400_000;
}

export function runCostScenarios<S extends { label: string }>(
  candles: Candle[],
  strategy: Strategy,
  baseConfig: BacktestConfig,
  interval: CandleInterval,
  scenarios: S[],
  applyScenario: (config: BacktestConfig, scenario: S) => BacktestConfig,
  isBase: (scenario: S) => boolean,
): CostScenarioResult<S>[] {
  const tradingDays = tradingDaysFromCandles(candles);

  const results: { scenario: S; metrics: Metrics }[] = [];

  for (const scenario of scenarios) {
    const config = applyScenario(baseConfig, scenario);
    const result = runBacktest(candles, strategy, config, interval);
    const rawMetrics = computeMetrics(result.trades, result.maxDrawdownPct, tradingDays, baseConfig.initialCapital);
    const metrics = { ...rawMetrics, ...computeRiskMetrics(result.equityPoints) };
    results.push({ scenario, metrics });
  }

  const baseResult = results.find(r => isBase(r.scenario)) ?? results[0];
  const basePnl = baseResult.metrics.totalPnl ?? 0;
  const basePf = baseResult.metrics.profitFactor ?? 0;
  const baseEdge = baseResult.metrics.edgeBpsNet ?? 0;

  return results.map(r => ({
    scenario: r.scenario,
    metrics: r.metrics,
    deltaVsBase: {
      pnlDelta: (r.metrics.totalPnl ?? 0) - basePnl,
      pfDelta: (r.metrics.profitFactor ?? 0) - basePf,
      edgeBpsNetDelta: (r.metrics.edgeBpsNet ?? 0) - baseEdge,
    },
  }));
}
