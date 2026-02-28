import {
  buildContext,
  canTrade,
  createUtcDayFormatter,
  aggregateCandles,
  intervalToMs,
} from "@breaker/backtest";
import type { Strategy, Candle, CandleInterval, StrategyContext } from "@breaker/backtest";
import type { CandleStreamer } from "../adapters/candle-streamer.js";
import type { ExchangeConfig } from "../types/config.js";
import type { PositionBook } from "../domain/position-book.js";
import { handleSignal, type SignalHandlerDeps } from "./handle-signal.js";
import type { EventLog } from "../adapters/event-log.js";
import { truncatePrice } from "../lib/truncate-price.js";
import { logger } from "../lib/logger.js";

const log = logger.createChild("strategyRunner");

export interface StrategyRunnerDeps {
  config: ExchangeConfig;
  strategy: Strategy;
  streamer: CandleStreamer;
  positionBook: PositionBook;
  signalHandlerDeps: SignalHandlerDeps;
  eventLog: EventLog;
  onNewCandle?: (candle: Candle) => void;
  onStaleData?: (info: { lastCandleAt: number; silentMs: number }) => void;
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
  private lastExitLevel: number | null = null;
  private trailingSlOid: number | null = null;
  private lastCandleAt = 0;

  constructor(deps: StrategyRunnerDeps) {
    this.deps = deps;
  }

  async warmup(): Promise<void> {
    const candles = await this.deps.streamer.warmup(this.deps.config.warmupBars);

    const minBars = Math.ceil(this.deps.config.warmupBars * 0.5);
    if (candles.length < minBars) {
      throw new Error(
        `Insufficient warmup data: got ${candles.length}, need ≥${minBars} (${this.deps.config.warmupBars} requested)`,
      );
    }

    const higherTimeframes = this.buildHigherTimeframes(candles);
    this.deps.strategy.init?.(candles, higherTimeframes);

    if (candles.length > 0) {
      this.lastCandleAt = candles[candles.length - 1].t;
    }

    // Recover trailing SL oid from SQLite for existing positions (cold-start).
    const pos = this.deps.positionBook.get(this.deps.config.asset);
    if (pos) {
      const pendingOrders = this.deps.signalHandlerDeps.store.getPendingOrders();
      const trailingSlOrder = pendingOrders.find(
        (o) => o.coin === this.deps.config.asset && o.tag === "trailing-sl",
      );
      if (trailingSlOrder?.hl_order_id) {
        this.trailingSlOid = Number(trailingSlOrder.hl_order_id);
      }
    }

    // Initialize trailing exit level for existing positions (cold-start).
    if (pos && this.deps.strategy.getExitLevel && candles.length > 0) {
      const ctx = buildContext({
        candles,
        index: candles.length - 1,
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
      this.lastExitLevel = this.deps.strategy.getExitLevel(ctx);
    }

    await this.deps.eventLog.append({
      type: "warmup_complete",
      timestamp: new Date().toISOString(),
      data: { bars: candles.length },
    });
  }

  /**
   * Public wrapper for tests — reads the latest candle from the streamer
   * and processes it if it hasn't been processed yet.
   */
  async tick(): Promise<void> {
    const candles = this.deps.streamer.getCandles();
    if (candles.length === 0) return;
    const latest = candles[candles.length - 1];
    if (latest.t <= this.lastCandleAt) return;
    this.deps.onNewCandle?.(latest);
    await this.processClosedCandle(latest);
  }

  private async processClosedCandle(newCandle: Candle): Promise<void> {
    this.lastCandleAt = newCandle.t;

    const candles = this.deps.streamer.getCandles();
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

    const higherTimeframes = this.buildHigherTimeframes(candles);

    // Exit takes priority: if we close a position, skip entry check on the same
    // candle to avoid immediate re-entry oscillation from the same bar's signal.
    const pos = this.deps.positionBook.get(this.deps.config.asset) ?? null;
    if (pos) {
      this.deps.positionBook.updatePrice(this.deps.config.asset, newCandle.c);
      const exited = await this.checkExit(pos, candles, index, higherTimeframes);
      if (exited) return;
    }

    if (pos === null) {
      await this.checkEntry(candles, index, higherTimeframes, newCandle.c);
    }
  }

  private async checkExit(
    pos: ReturnType<PositionBook["get"]> & {},
    candles: Candle[],
    index: number,
    higherTimeframes: Record<string, Candle[]>,
  ): Promise<boolean> {
    if (!this.deps.strategy.shouldExit) return false;

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
      log.info({ action: "exitTriggered", coin: this.deps.config.asset, direction: pos.direction, unrealizedPnl: pos.unrealizedPnl, comment: exitSignal.comment }, "Strategy exit triggered");
      const { hlClient } = this.deps.signalHandlerDeps;
      const closeSide = pos.direction === "long" ? "sell" : "buy";
      await hlClient.placeMarketOrder(this.deps.config.asset, closeSide === "buy", pos.size);
      this.deps.positionBook.close(this.deps.config.asset);
      this.barsSinceExit = 0;
      this.lastExitLevel = null;
      this.trailingSlOid = null;
      if (pos.unrealizedPnl < 0) this.consecutiveLosses++;
      else this.consecutiveLosses = 0;
      this.dailyPnl += pos.unrealizedPnl;
      log.info({ action: "positionClosed", coin: this.deps.config.asset, pnl: pos.unrealizedPnl }, "Position closed");
      return true;
    }

    await this.trackTrailingExit(pos, ctx);
    return false;
  }

  private async trackTrailingExit(
    pos: ReturnType<PositionBook["get"]> & {},
    ctx: StrategyContext,
  ): Promise<void> {
    if (!this.deps.strategy.getExitLevel) return;

    const newLevel = this.deps.strategy.getExitLevel(ctx);
    if (newLevel === null) return;

    const isMoreProtective =
      (pos.direction === "long" && newLevel > pos.stopLoss) ||
      (pos.direction === "short" && newLevel < pos.stopLoss);

    const movedFavorably = this.lastExitLevel !== null && (
      (pos.direction === "long" && newLevel > this.lastExitLevel) ||
      (pos.direction === "short" && newLevel < this.lastExitLevel)
    );

    const isFirstLevel = this.lastExitLevel === null;
    const shouldPlace = isMoreProtective && (movedFavorably || isFirstLevel);

    if (movedFavorably) {
      log.info({ action: "trailingSlMoved", coin: this.deps.config.asset, oldLevel: this.lastExitLevel, newLevel }, "Trailing SL moved");
      Promise.resolve(
        this.deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved(
          this.deps.config.asset,
          pos.direction,
          this.lastExitLevel!,
          newLevel,
          pos.entryPrice,
          this.deps.config.mode,
        ),
      ).catch((err) => {
        log.warn({ action: "trailingSlNotifyFailed", err }, "Trailing SL notification failed");
      });
    }

    if (shouldPlace) {
      await this.placeTrailingSlOrder(pos, newLevel);
    }

    this.lastExitLevel = newLevel;
  }

  private async placeTrailingSlOrder(
    pos: ReturnType<PositionBook["get"]> & {},
    newLevel: number,
  ): Promise<void> {
    const { hlClient, store } = this.deps.signalHandlerDeps;
    const coin = this.deps.config.asset;
    const truncatedLevel = truncatePrice(newLevel);
    const oldOid = this.trailingSlOid;

    try {
      const result = await hlClient.placeStopOrder(
        coin,
        pos.direction === "long",
        pos.size,
        truncatedLevel,
        true,
      );

      const signalId = pos.signalId ?? -1;
      store.insertOrder({
        signal_id: signalId,
        hl_order_id: result.orderId,
        coin,
        side: pos.direction === "long" ? "sell" : "buy",
        size: pos.size,
        price: truncatedLevel,
        order_type: "stop",
        tag: "trailing-sl",
        status: "pending",
        mode: this.deps.config.mode,
        filled_at: null,
      });

      this.trailingSlOid = Number(result.orderId);
      this.deps.positionBook.updateTrailingStopLoss(coin, truncatedLevel);
      log.info({ action: "trailingSlPlaced", coin, level: truncatedLevel, oid: result.orderId }, "Trailing SL order placed");

      // Cancel old trailing SL after placing new one (place-first guarantees coverage)
      if (oldOid !== null) {
        try {
          await hlClient.cancelOrder(coin, oldOid);
          store.updateOrderStatus(
            store.getPendingOrders().find(
              (o) => o.hl_order_id === String(oldOid) && o.tag === "trailing-sl",
            )?.id ?? -1,
            "cancelled",
          );
          log.info({ action: "trailingSlCancelled", coin, oid: oldOid }, "Old trailing SL cancelled");
        } catch (cancelErr) {
          log.warn({ action: "trailingSlCancelFailed", coin, oid: oldOid, err: cancelErr }, "Failed to cancel old trailing SL (3 orders briefly)");
        }
      }
    } catch (placeErr) {
      log.error({ action: "trailingSlPlaceFailed", coin, level: truncatedLevel, err: placeErr }, "Trailing SL placement failed (fixed SL still active)");
    }
  }

  private async checkEntry(
    candles: Candle[],
    index: number,
    higherTimeframes: Record<string, Candle[]>,
    currentPrice: number,
  ): Promise<void> {
    this.barsSinceExit++;

    const tradingAllowed = canTrade({
      barsSinceExit: this.barsSinceExit,
      cooldownBars: this.deps.config.guardrails.cooldownBars,
      consecutiveLosses: this.consecutiveLosses,
      // Matches backtest engine default; keeps exchange behavior identical to
      // backtested results. Not configurable to prevent config drift.
      maxConsecutiveLosses: 2,
      dailyPnl: this.dailyPnl,
      maxDailyLossR: this.deps.config.guardrails.maxDailyLossUsd,
      initialCapital: 10000,
      tradesToday: this.tradesToday,
      maxTradesPerDay: this.deps.config.guardrails.maxTradesPerDay,
      maxGlobalTradesDay: this.deps.config.guardrails.maxTradesPerDay,
    });

    if (!tradingAllowed) {
      log.debug({ action: "tradingBlocked", barsSinceExit: this.barsSinceExit, consecutiveLosses: this.consecutiveLosses, tradesToday: this.tradesToday }, "Trading blocked by guardrails");
      return;
    }

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

    log.info({ action: "signalGenerated", coin: this.deps.config.asset, direction: signal.direction, entryPrice: signal.entryPrice, stopLoss: signal.stopLoss }, "Strategy signal generated");

    this.signalCounter++;
    const alertId = `runner-${Date.now()}-${this.signalCounter}`;

    const result = await handleSignal(
      { signal, currentPrice, source: "strategy-runner", alertId },
      this.deps.signalHandlerDeps,
    );

    if (result.success) {
      this.tradesToday++;
      this.lastExitLevel = null;
      this.trailingSlOid = null;
    }
  }

  private buildHigherTimeframes(candles: Candle[]): Record<string, Candle[]> {
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
    return higherTimeframes;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.deps.streamer.on("candle:close", async (candle) => {
      if (!this.running) return;
      try {
        await this.processClosedCandle(candle);
      } catch (err) {
        await this.deps.eventLog.append({
          type: "error",
          timestamp: new Date().toISOString(),
          data: { message: (err as Error).message, stack: (err as Error).stack },
        });
      }
    });

    this.deps.streamer.on("candle:tick", (candle) => {
      if (!this.running) return;
      const tickPos = this.deps.positionBook.get(this.deps.config.asset);
      if (tickPos) this.deps.positionBook.updatePrice(this.deps.config.asset, candle.c);
      this.deps.onNewCandle?.(candle);
    });

    this.deps.streamer.on("stale", (info) => {
      if (!this.running) return;
      this.deps.onStaleData?.(info);
    });

    this.deps.streamer.start();
  }

  stop(): void {
    this.running = false;
    this.deps.streamer.removeAllListeners();
    this.deps.streamer.stop();
  }

  isRunning(): boolean {
    return this.running;
  }

  getLastCandleAt(): number {
    return this.lastCandleAt;
  }

  getLastExitLevel(): number | null {
    return this.lastExitLevel;
  }
}
