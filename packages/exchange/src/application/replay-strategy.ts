import { buildContext, aggregateCandles } from "@breaker/backtest";
import type { Strategy, Candle, CandleInterval } from "@breaker/backtest";

export interface ReplaySignal {
  t: number;
  direction: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  comment: string;
  strategyName: string;
}

export interface ReplayParams {
  strategyFactory: () => Strategy;
  candles: Candle[];
  interval: CandleInterval;
  strategyName?: string;
}

export function replayStrategy(params: ReplayParams): ReplaySignal[] {
  const { candles, interval } = params;
  if (candles.length === 0) return [];

  const strategy = params.strategyFactory();
  const signals: ReplaySignal[] = [];

  // Aggregate higher timeframes if strategy requires them
  const higherTimeframes: Record<string, Candle[]> = {};
  if (strategy.requiredTimeframes) {
    for (const tf of strategy.requiredTimeframes) {
      higherTimeframes[tf] = aggregateCandles(candles, interval, tf as CandleInterval);
    }
  }

  // Initialize strategy
  strategy.init?.(candles, higherTimeframes);

  // Run strategy on each candle
  for (let i = 0; i < candles.length; i++) {
    const ctx = buildContext({
      candles,
      index: i,
      position: null,
      higherTimeframes,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
      consecutiveLosses: 0,
    });

    const signal = strategy.onCandle(ctx);
    if (signal) {
      signals.push({
        t: candles[i].t,
        direction: signal.direction,
        entryPrice: signal.entryPrice ?? candles[i].c,
        stopLoss: signal.stopLoss,
        comment: signal.comment,
        strategyName: params.strategyName ?? "",
      });
    }
  }

  return signals;
}
