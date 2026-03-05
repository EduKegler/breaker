import type { Candle } from "../types/candle.js";
import type { StrategyContext, ConditionResult } from "../types/strategy.js";
import type { Position } from "../types/order.js";

export interface BuildContextParams {
  candles: Candle[];
  index: number;
  position: Position | null;
  higherTimeframes: Record<string, Candle[]>;
  dailyPnl: number;
  tradesToday: number;
  barsSinceExit: number;
  diagnosticsEnabled?: boolean;
}

export interface DiagnosticStrategyContext extends StrategyContext {
  getConditions(): Record<string, ConditionResult>;
  getIndicators(): Record<string, number>;
}

// No-op passthrough — zero allocation when diagnostics disabled
const noopTrack = (_n: string, passed: boolean): boolean => passed;
const noopIndicator = (): void => {};

export function buildContext(p: BuildContextParams): DiagnosticStrategyContext {
  const enabled = p.diagnosticsEnabled ?? false;

  let conditions: Record<string, ConditionResult> = {};
  let indicators: Record<string, number> = {};

  const track = enabled
    ? (name: string, passed: boolean, value?: number, threshold?: number): boolean => {
        conditions[name] = { passed, value, threshold };
        return passed;
      }
    : noopTrack;

  const indicator = enabled
    ? (name: string, value: number): void => {
        indicators[name] = value;
      }
    : noopIndicator;

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
    track,
    indicator,
    getConditions: () => conditions,
    getIndicators: () => indicators,
  };
}
