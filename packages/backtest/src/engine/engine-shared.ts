import type { Candle } from "../types/candle.js";
import type { StrategyContext } from "../types/strategy.js";
import type { Position } from "../types/order.js";

export interface CanTradeParams {
  barsSinceExit: number;
  cooldownBars: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  dailyPnl: number;
  maxDailyLossR: number;
  initialCapital: number;
  tradesToday: number;
  maxTradesPerDay: number;
  maxGlobalTradesDay: number;
}

export function canTrade(p: CanTradeParams): boolean {
  return (
    p.barsSinceExit >= p.cooldownBars &&
    p.consecutiveLosses < p.maxConsecutiveLosses &&
    p.dailyPnl > -(p.maxDailyLossR * p.initialCapital * 0.01) &&
    p.tradesToday < Math.min(p.maxTradesPerDay, p.maxGlobalTradesDay)
  );
}

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

export function createUtcDayFormatter(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    day: "numeric",
    month: "numeric",
  });
}
