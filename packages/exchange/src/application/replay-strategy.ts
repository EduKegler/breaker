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

  // Simulate minimal position tracking so the strategy sees realistic state.
  // Without this, onCandle fires on every bar (position: null, barsSinceExit: 999)
  // producing duplicate markers on consecutive candles.
  let inPosition = false;
  let positionDirection: "long" | "short" | null = null;
  let positionEntryBar = 0;
  let barsSinceExit = 999;

  // Run strategy on each candle
  for (let i = 0; i < candles.length; i++) {
    // Simulate position exit after timeout (approximate — uses strategy's timeoutBars or 30 default)
    if (inPosition) {
      const barsHeld = i - positionEntryBar;
      const timeoutBars = Number(strategy.params?.timeoutBars?.value ?? 30);
      if (barsHeld >= timeoutBars) {
        inPosition = false;
        positionDirection = null;
        barsSinceExit = 0;
      }
    }

    if (!inPosition) {
      barsSinceExit++;
    }

    const ctx = buildContext({
      candles,
      index: i,
      position: inPosition ? {
        direction: positionDirection ?? "long",
        entryPrice: candles[positionEntryBar]?.c ?? 0,
        size: 0.001,
        entryTimestamp: candles[positionEntryBar]?.t ?? 0,
        entryBarIndex: positionEntryBar,
        unrealizedPnl: 0,
        accumulatedFunding: 0,
        fills: [],
      } : null,
      higherTimeframes,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit,
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

      // Mark as in-position to suppress subsequent signals
      inPosition = true;
      positionDirection = signal.direction;
      positionEntryBar = i;
    }
  }

  return signals;
}
