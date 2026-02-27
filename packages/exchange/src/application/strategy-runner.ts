import {
  buildContext,
  canTrade,
  createUtcDayFormatter,
  aggregateCandles,
  intervalToMs,
} from "@breaker/backtest";
import type { Strategy, Candle, CandleInterval } from "@breaker/backtest";
import type { CandlePoller } from "../adapters/candle-poller.js";
import type { ExchangeConfig } from "../types/config.js";
import type { PositionBook } from "../domain/position-book.js";
import { handleSignal, type SignalHandlerDeps } from "./signal-handler.js";
import type { EventLog } from "../adapters/event-log.js";
import { setTimeout as sleep } from "node:timers/promises";

export interface StrategyRunnerDeps {
  config: ExchangeConfig;
  strategy: Strategy;
  poller: CandlePoller;
  positionBook: PositionBook;
  signalHandlerDeps: SignalHandlerDeps;
  eventLog: EventLog;
  onNewCandle?: (candle: Candle) => void;
}

export class StrategyRunner {
  private deps: StrategyRunnerDeps;
  private running = false;
  private barsSinceExit = 999;
  private consecutiveLosses = 0;
  private dailyPnl = 0;
  private tradesToday = 0;
  private lastTradeDay = "";
  private utcDayFormatter = createUtcDayFormatter();
  private signalCounter = 0;

  constructor(deps: StrategyRunnerDeps) {
    this.deps = deps;
  }

  async warmup(): Promise<void> {
    const candles = await this.deps.poller.warmup(this.deps.config.warmupBars);

    // Compute higher timeframes if strategy needs them
    const higherTimeframes: Record<string, Candle[]> = {};
    if (this.deps.strategy.requiredTimeframes) {
      for (const tf of this.deps.strategy.requiredTimeframes) {
        higherTimeframes[tf] = aggregateCandles(
          candles,
          this.deps.config.interval as CandleInterval,
          tf as CandleInterval,
        );
      }
    }

    // Initialize strategy with historical data
    this.deps.strategy.init?.(candles, higherTimeframes);

    await this.deps.eventLog.append({
      type: "warmup_complete",
      timestamp: new Date().toISOString(),
      data: { bars: candles.length },
    });
  }

  async tick(): Promise<void> {
    const newCandle = await this.deps.poller.poll();
    if (!newCandle) return;

    this.deps.onNewCandle?.(newCandle);

    const candles = this.deps.poller.getCandles();
    const index = candles.length - 1;

    await this.deps.eventLog.append({
      type: "candle_polled",
      timestamp: new Date().toISOString(),
      data: { t: newCandle.t, c: newCandle.c },
    });

    // Daily reset (same as backtest engine)
    const currentDay = this.utcDayFormatter.format(new Date(newCandle.t));
    if (currentDay !== this.lastTradeDay) {
      this.dailyPnl = 0;
      this.tradesToday = 0;
      this.consecutiveLosses = 0;
      this.lastTradeDay = currentDay;
    }

    // Higher timeframes for context
    const higherTimeframes: Record<string, Candle[]> = {};
    if (this.deps.strategy.requiredTimeframes) {
      for (const tf of this.deps.strategy.requiredTimeframes) {
        higherTimeframes[tf] = aggregateCandles(
          candles,
          this.deps.config.interval as CandleInterval,
          tf as CandleInterval,
        );
      }
    }

    // Update price on existing position
    const pos = this.deps.positionBook.get(this.deps.config.asset);
    if (pos) {
      this.deps.positionBook.updatePrice(this.deps.config.asset, newCandle.c);
    }

    // Check for strategy-driven exit (when in position)
    if (pos && this.deps.strategy.shouldExit) {
      const ctx = buildContext({
        candles,
        index,
        position: {
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          size: pos.size,
          entryTimestamp: new Date(pos.openedAt).getTime(),
          entryBarIndex: 0,
          unrealizedPnl: pos.unrealizedPnl,
          fills: [],
        },
        higherTimeframes,
        dailyPnl: this.dailyPnl,
        tradesToday: this.tradesToday,
        barsSinceExit: this.barsSinceExit,
        consecutiveLosses: this.consecutiveLosses,
      });

      const exitSignal = this.deps.strategy.shouldExit(ctx);
      if (exitSignal?.exit) {
        // Close position via market order
        const { hlClient } = this.deps.signalHandlerDeps;
        const closeSide = pos.direction === "long" ? "sell" : "buy";
        await hlClient.placeMarketOrder(this.deps.config.asset, closeSide === "buy", pos.size);
        this.deps.positionBook.close(this.deps.config.asset);
        this.barsSinceExit = 0;
        // PnL tracking simplified — real PnL comes from fills
        if (pos.unrealizedPnl < 0) this.consecutiveLosses++;
        else this.consecutiveLosses = 0;
        this.dailyPnl += pos.unrealizedPnl;
        return;
      }
    }

    // Check for new entry (when flat)
    if (this.deps.positionBook.isFlat(this.deps.config.asset)) {
      this.barsSinceExit++;

      const tradingAllowed = canTrade({
        barsSinceExit: this.barsSinceExit,
        cooldownBars: this.deps.config.guardrails.cooldownBars,
        consecutiveLosses: this.consecutiveLosses,
        maxConsecutiveLosses: 2, // hardcoded as in backtest default
        dailyPnl: this.dailyPnl,
        maxDailyLossR: this.deps.config.guardrails.maxDailyLossUsd,
        initialCapital: 10000, // daily loss is in USD, not R-based in exchange
        tradesToday: this.tradesToday,
        maxTradesPerDay: this.deps.config.guardrails.maxTradesPerDay,
        maxGlobalTradesDay: this.deps.config.guardrails.maxTradesPerDay,
      });

      if (!tradingAllowed) return;

      const ctx = buildContext({
        candles,
        index,
        position: null,
        higherTimeframes,
        dailyPnl: this.dailyPnl,
        tradesToday: this.tradesToday,
        barsSinceExit: this.barsSinceExit,
        consecutiveLosses: this.consecutiveLosses,
      });

      const signal = this.deps.strategy.onCandle(ctx);
      if (!signal) return;

      this.signalCounter++;
      const alertId = `runner-${Date.now()}-${this.signalCounter}`;

      const result = await handleSignal(
        { signal, currentPrice: newCandle.c, source: "strategy-runner", alertId },
        this.deps.signalHandlerDeps,
      );

      if (result.success) {
        this.tradesToday++;
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    const pollIntervalMs = intervalToMs(this.deps.config.interval as CandleInterval);

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        await this.deps.eventLog.append({
          type: "error",
          timestamp: new Date().toISOString(),
          data: { message: (err as Error).message, stack: (err as Error).stack },
        });
      }
      await sleep(pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}
