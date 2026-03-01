import type { Candle } from "./candle.js";

export interface Signal {
  direction: "long" | "short";
  entryPrice: number | null; // null = market order (use current close)
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
  comment: string;
}

export interface StrategyParam {
  value: number;
  min: number;
  max: number;
  step: number;
  optimizable: boolean;
  description?: string;
}

export interface StrategyContext {
  candles: Candle[];
  index: number; // current bar index
  currentCandle: Candle;
  positionDirection: "long" | "short" | null;
  positionEntryPrice: number | null;
  positionEntryBarIndex: number | null;
  higherTimeframes: Record<string, Candle[]>;
  dailyPnl: number;
  tradesToday: number;
  barsSinceExit: number;
  consecutiveLosses: number;
}

export interface Strategy {
  name: string;
  params: Record<string, StrategyParam>;
  init?(candles: Candle[], higherTimeframes: Record<string, Candle[]>): void;
  onCandle(ctx: StrategyContext): Signal | null;
  shouldExit?(ctx: StrategyContext): { exit: boolean; comment: string } | null;
  getExitLevel?(ctx: StrategyContext): number | null;
  requiredTimeframes?: string[];
  /** Minimum candles needed per timeframe before signals can generate.
   * "source" = base interval candles; HTF keys (e.g. "1h", "4h", "1d") = aggregated candles. */
  requiredWarmup?: Record<string, number>;
}
