// Types
export type { Candle } from "./types/candle.js";
export { CandleInterval, CandleSchema, intervalToMs } from "./types/candle.js";
export type { Strategy, StrategyContext, StrategyParam, Signal } from "./types/strategy.js";
export type { Order, Position, CompletedTrade, Fill, OrderSide, OrderType } from "./types/order.js";
export type {
  Metrics,
  Thresholds,
  CriteriaResult,
  DirectionStats,
  ExitTypeStats,
  HourStats,
  DayStats,
  HourSim,
  DaySim,
  RemoveAllSL,
  FilterSimulations,
  HourConsistency,
  WalkForward,
  SessionName,
  SessionStats,
  TradeAnalysis,
} from "./types/metrics.js";

// Indicators
export { ema } from "./indicators/ema.js";
export { sma } from "./indicators/sma.js";
export { atr } from "./indicators/atr.js";
export { trueRange } from "./indicators/true-range.js";
export { donchian } from "./indicators/donchian.js";
export type { DonchianResult } from "./indicators/donchian.js";
export { adx } from "./indicators/adx.js";
export type { AdxResult } from "./indicators/adx.js";
export { rsi } from "./indicators/rsi.js";
export { keltner } from "./indicators/keltner.js";
export type { KeltnerResult } from "./indicators/keltner.js";

// Engine
export { runBacktest, DEFAULT_BACKTEST_CONFIG } from "./engine/engine.js";
export type { BacktestConfig, BacktestResult, SizingMode } from "./engine/engine.js";
export { aggregateCandles } from "./engine/aggregate-candles.js";
export { buildContext } from "./engine/build-context.js";
export type { BuildContextParams } from "./engine/build-context.js";
export { canTrade } from "./engine/can-trade.js";
export type { CanTradeParams } from "./engine/can-trade.js";
export { createUtcDayFormatter } from "./engine/create-utc-day-formatter.js";
export { EquityCurve } from "./engine/equity-curve.js";
export type { EquityPoint } from "./engine/equity-curve.js";
export { applySlippage } from "./engine/apply-slippage.js";
export { calculateCommission } from "./engine/calculate-commission.js";
export { computeMinWarmupBars } from "./engine/compute-min-warmup-bars.js";
export { DEFAULT_EXECUTION } from "./engine/execution-model.js";
export type { ExecutionConfig } from "./engine/execution-model.js";

// Analysis
export { computeMetrics } from "./analysis/metrics-calculator.js";
export { analyzeTradeList } from "./analysis/trade-analysis.js";
export { getSessionForHour } from "./analysis/get-session-for-hour.js";
export { computeWalkForward } from "./analysis/walk-forward.js";
export { computeFilterSimulations } from "./analysis/filter-simulation.js";

// Data
export { fetchCandles } from "./data/fetch-candles.js";
export type { CandleClientOptions } from "./data/fetch-candles.js";
export { streamCandles } from "./data/stream-candles.js";
export type { StreamCandlesOptions, ProExchange } from "./data/stream-candles.js";
export { toSymbol } from "./data/to-symbol.js";
export type { DataSource } from "./data/to-symbol.js";
export { CandleCache } from "./data/candle-cache.js";

// Strategies
export { createDonchianAdx } from "./strategies/donchian-adx.js";
export { createKeltnerRsi2 } from "./strategies/keltner-rsi2.js";
export { createEmaPullback } from "./strategies/ema-pullback.js";
