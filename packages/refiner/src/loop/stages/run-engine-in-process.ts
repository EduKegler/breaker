import {
  runBacktest,
  computeMetrics,
  analyzeTradeList,
  DEFAULT_BACKTEST_CONFIG,
} from "@breaker/backtest";
import type {
  Candle,
  CandleInterval,
  Strategy,
  BacktestConfig,
  Metrics,
  TradeAnalysis,
  CompletedTrade,
} from "@breaker/backtest";

interface EngineResult {
  metrics: Metrics;
  analysis: TradeAnalysis;
  trades: CompletedTrade[];
}

/**
 * Run backtest in-process (refine phase -- param changes only, ~2s).
 * Strategy is created from factory with param overrides, no rebuild needed.
 */
export function runEngineInProcess(opts: {
  candles: Candle[];
  strategy: Strategy;
  config?: Partial<BacktestConfig>;
  sourceInterval?: CandleInterval;
  warmupBars?: number;
}): EngineResult {
  const { candles, strategy, config, sourceInterval = "15m", warmupBars = 0 } = opts;

  const backtestConfig: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...config,
    warmupBars,
  };

  const result = runBacktest(candles, strategy, backtestConfig, sourceInterval);

  const metrics = computeMetrics(result.trades, result.maxDrawdownPct);
  const analysis = analyzeTradeList(result.trades);

  return { metrics, analysis, trades: result.trades };
}
