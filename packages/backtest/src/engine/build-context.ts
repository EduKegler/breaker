import type { Candle } from "../types/candle.js";
import type { StrategyContext } from "../types/strategy.js";
import type { Position } from "../types/order.js";

export interface BuildContextParams {
  candles: Candle[];
  index: number;
  position: Position | null;
  higherTimeframes: Record<string, Candle[]>;
  dailyPnl: number;
  tradesToday: number;
  barsSinceExit: number;
  consecutiveLosses: number;
}

export function buildContext(p: BuildContextParams): StrategyContext {
  return {
    candles: p.candles,
    index: p.index,
    currentCandle: p.candles[p.index],
    positionDirection: p.position?.direction ?? null,
    positionEntryPrice: p.position?.entryPrice ?? null,
    positionEntryBarIndex: p.position?.entryBarIndex ?? null,
    higherTimeframes: p.higherTimeframes,
    dailyPnl: p.dailyPnl,
    tradesToday: p.tradesToday,
    barsSinceExit: p.barsSinceExit,
    consecutiveLosses: p.consecutiveLosses,
  };
}
