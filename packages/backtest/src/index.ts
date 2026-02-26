// Types
export type { Candle, CandleInterval } from "./types/candle.js";
export { CandleSchema, intervalToMs } from "./types/candle.js";
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
export { atr, trueRange } from "./indicators/atr.js";
export { donchian } from "./indicators/donchian.js";
export type { DonchianResult } from "./indicators/donchian.js";
export { adx } from "./indicators/adx.js";
export type { AdxResult } from "./indicators/adx.js";
export { rsi } from "./indicators/rsi.js";
export { keltner } from "./indicators/keltner.js";
export type { KeltnerResult } from "./indicators/keltner.js";

// Engine
export { runBacktest, aggregateCandles, DEFAULT_BACKTEST_CONFIG } from "./engine/engine.js";
export type { BacktestConfig, BacktestResult, SizingMode } from "./engine/engine.js";
export { buildContext, canTrade, createUtcDayFormatter } from "./engine/engine-shared.js";
export type { BuildContextParams, CanTradeParams } from "./engine/engine-shared.js";
export { EquityCurve } from "./engine/equity-curve.js";
export type { EquityPoint } from "./engine/equity-curve.js";
export { applySlippage, calculateCommission, DEFAULT_EXECUTION } from "./engine/execution-model.js";
export type { ExecutionConfig } from "./engine/execution-model.js";

// Analysis
export { computeMetrics } from "./analysis/metrics-calculator.js";
export { analyzeTradeList, getSessionForHour } from "./analysis/trade-analysis.js";
export { computeWalkForward } from "./analysis/walk-forward.js";
export { computeFilterSimulations } from "./analysis/filter-simulation.js";

// Data
export { fetchCandles } from "./data/candle-client.js";
export type { CandleClientOptions, DataSource } from "./data/candle-client.js";
export { CandleCache } from "./data/candle-cache.js";

// Strategies
export { createDonchianAdx } from "./strategies/donchian-adx.js";
export { createKeltnerRsi2 } from "./strategies/keltner-rsi2.js";
