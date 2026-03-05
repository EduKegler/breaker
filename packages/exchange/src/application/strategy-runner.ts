import {
  buildContext,
  canTrade,
  createUtcDayFormatter,
  aggregateCandles,
  intervalToMs,
  bollingerBands,
  keltner,
  detectSqueeze,
} from "@breaker/backtest";
import type { Strategy, Signal, Candle, CandleInterval, StrategyContext } from "@breaker/backtest";
import type { CandleStreamer } from "../adapters/candle-streamer.js";
import type { ExchangeConfig } from "../types/config.js";
import type { PositionBook } from "../domain/position-book.js";
import { handleSignal, type SignalHandlerDeps } from "./handle-signal.js";
import type { EventLog } from "../adapters/event-log.js";
import type { Orchestrator } from "../domain/orchestrator.js";
import { truncatePrice } from "@breaker/kit";
import { logger } from "../lib/logger.js";

const log = logger.createChild("strategyRunner");

export interface StrategyRunnerDeps {
  config: ExchangeConfig;
  coin: string;
  leverage: number;
  interval: CandleInterval;
  warmupBars: number;
  autoTradingEnabled: boolean;
  strategy: Strategy;
  strategyConfigName: string;
  streamer: CandleStreamer;
  positionBook: PositionBook;
  signalHandlerDeps: SignalHandlerDeps;
  eventLog: EventLog;
  orchestrator?: Orchestrator;
  onNewCandle?: (candle: Candle) => void;
  onStaleData?: (info: { lastCandleAt: number; silentMs: number }) => void;
}

export class StrategyRunner {
  private deps: StrategyRunnerDeps;
  private running = false;
  private barsSinceExit = 999;
  private dailyPnl = 0;
  private tradesToday = 0;
  private lastTradeDay = "";
  private utcDayFormatter = createUtcDayFormatter();
  private signalCounter = 0;
  private lastExitLevel: number | null = null;
  private trailingSlOid: number | null = null;
  private lastCandleAt = 0;
  private entryBarIndex: number | null = null;
  private lastSignalResult: { t: number; hadSignal: boolean } | null = null;

  constructor(deps: StrategyRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Generate a signal from the strategy using the current candle state.
   * Used by /quick-signal to delegate SL/TP computation to the strategy
   * artifact — keeps the endpoint strategy-agnostic.
   */
  generateSignal(): Signal | null {
    const candles = this.deps.streamer.getCandles();
    if (candles.length === 0) return null;

    const index = candles.length - 1;
    const higherTimeframes = this.buildHigherTimeframes(candles);

    // Re-init indicator caches so they cover all current candles
    this.deps.strategy.init?.(candles, higherTimeframes);

    const ctx = buildContext({
      candles,
      index,
      position: null,
      higherTimeframes,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
    });

    return this.deps.strategy.onCandle(ctx);
  }

  /**
   * Compute SL/TPs for a manual signal in the given direction.
   * Uses strategy.computeLevels() — skips entry conditions, keeps endpoint
   * fully strategy-agnostic.
   */
  generateManualSignal(direction: "long" | "short"): Signal | null {
    if (!this.deps.strategy.computeLevels) return null;

    const candles = this.deps.streamer.getCandles();
    if (candles.length === 0) return null;

    const index = candles.length - 1;
    const higherTimeframes = this.buildHigherTimeframes(candles);
    this.deps.strategy.init?.(candles, higherTimeframes);

    const ctx = buildContext({
      candles,
      index,
      position: null,
      higherTimeframes,
      dailyPnl: 0,
      tradesToday: 0,
      barsSinceExit: 999,
    });

    const levels = this.deps.strategy.computeLevels(ctx, direction);
    if (!levels) return null;

    return {
      direction,
      entryPrice: null,
      stopLoss: levels.stopLoss,
      takeProfits: levels.takeProfits,
      comment: "Manual from dashboard",
    };
  }

  async warmup(): Promise<void> {
    const oneYearBars = Math.ceil(365 * 86_400_000 / intervalToMs(this.deps.interval));
    const effectiveWarmup = Math.max(this.deps.warmupBars, oneYearBars);
    if (effectiveWarmup > this.deps.warmupBars) {
      log.warn(
        { coin: this.deps.coin, configured: this.deps.warmupBars, oneYearFloor: oneYearBars, effective: effectiveWarmup },
        "warmupBars raised to 1-year floor",
      );
    }

    const candles = await this.deps.streamer.warmup(effectiveWarmup);

    const minBars = Math.ceil(this.deps.warmupBars * 0.5);
    if (candles.length < minBars) {
      throw new Error(
        `Insufficient warmup data: got ${candles.length}, need ≥${minBars} (${effectiveWarmup} requested)`,
      );
    }

    const higherTimeframes = this.buildHigherTimeframes(candles);
    this.deps.strategy.init?.(candles, higherTimeframes);

    if (candles.length > 0) {
      this.lastCandleAt = candles[candles.length - 1].t;
    }

    // Recover trailing SL oid from SQLite for existing positions (cold-start).
    const pos = this.deps.positionBook.get(this.deps.coin);
    if (pos) {
      this.entryBarIndex = this.findEntryBarIndex(candles, pos.openedAt);

      const pendingOrders = this.deps.signalHandlerDeps.store.getPendingOrders();
      const trailingSlOrder = pendingOrders.find(
        (o) => o.coin === this.deps.coin && o.tag === "trailing-sl",
      );
      if (trailingSlOrder?.hl_order_id) {
        this.trailingSlOid = Number(trailingSlOrder.hl_order_id);
      }
    }

    // Initialize trailing exit level for existing positions (cold-start).
    // Use the actual trailing SL price from the exchange (if available) rather than
    // the current EMA value. This prevents a gap where the daemon thinks the level
    // is at the latest EMA but the exchange order is at an older, lower level —
    // causing the TSL to stay stuck until the EMA moves even higher.
    if (pos && this.deps.strategy.getExitLevel && candles.length > 0) {
      if (pos.trailingStopLoss != null && pos.trailingStopLoss > 0) {
        this.lastExitLevel = pos.trailingStopLoss;
      } else {
        const ctx = buildContext({
          candles,
          index: candles.length - 1,
          position: {
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            size: pos.size,
            entryTimestamp: new Date(pos.openedAt).getTime(),
            entryBarIndex: this.entryBarIndex ?? this.findEntryBarIndex(candles, pos.openedAt),
            unrealizedPnl: pos.unrealizedPnl,
            fills: [],
          },
          higherTimeframes,
          dailyPnl: this.dailyPnl,
          tradesToday: this.tradesToday,
          barsSinceExit: this.barsSinceExit,
        });
        this.lastExitLevel = this.deps.strategy.getExitLevel(ctx);
      }
    }

    await this.deps.eventLog.append({
      type: "warmup_complete",
      timestamp: new Date().toISOString(),
      data: { bars: candles.length, coin: this.deps.coin },
    });
  }

  /**
   * Public wrapper for tests — reads the latest candle from the streamer
   * and processes it if it hasn't been processed yet.
   */
  async tick(): Promise<void> {
    const candles = this.deps.streamer.getCandles();
    if (candles.length === 0) return;
    // Find the first unprocessed candle (not necessarily the last — the next
    // candle may already be in the array due to WS delivering ticks ahead of
    // the async reconciliation completing for the previous candle).
    const nextIdx = candles.findIndex(c => c.t > this.lastCandleAt);
    if (nextIdx < 0) return;
    await this.processClosedCandle(candles[nextIdx]);
  }

  private async processClosedCandle(newCandle: Candle): Promise<void> {
    this.lastCandleAt = newCandle.t;

    // Expire pending GTC entry for this coin if past deadline
    await this.expirePendingEntry();

    const candles = this.deps.streamer.getCandles();
    let index = candles.length - 1;

    // Guard against off-by-one: the next candle (N+1) may already be in the
    // array when reconcileAndEmitClose fires for candle N (because the WS
    // delivers the first tick of N+1 before the async REST reconciliation
    // completes). If the last candle doesn't match the closed candle, find
    // the correct index by timestamp.
    if (candles[index]?.t !== newCandle.t) {
      for (let i = candles.length - 2; i >= 0; i--) {
        if (candles[i].t === newCandle.t) { index = i; break; }
      }
    }

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
      this.lastTradeDay = currentDay;
    }
    this.deps.orchestrator?.resetDayIfNeeded(currentDay);
    this.deps.orchestrator?.reportPrice(this.deps.coin, newCandle.c, newCandle.t);
    this.reportSqueezeState(candles, newCandle.t);

    const higherTimeframes = this.buildHigherTimeframes(candles);

    // Refresh strategy indicator caches with current candle data.
    // init() pre-computes indicator arrays (EMA, RSI, ATR, etc.) sized to the
    // warmup candle set. As new candles arrive, their indices fall beyond the
    // cached arrays, causing onCandle()/shouldExit() to read undefined values
    // and silently return null. Re-calling init() extends the caches to cover
    // the full candle buffer (cost: ~O(N) every interval — negligible at 200 bars).
    this.deps.strategy.init?.(candles, higherTimeframes);

    // Exit takes priority: if we close a position, skip entry check on the same
    // candle to avoid immediate re-entry oscillation from the same bar's signal.
    const pos = this.deps.positionBook.get(this.deps.coin) ?? null;

    // Ownership guard: only manage exits if this runner opened the position
    // (entryBarIndex !== null). If another runner opened it, skip exit checks
    // — the SL/TP on the exchange protect the position regardless.
    if (pos && this.entryBarIndex !== null) {
      this.deps.positionBook.updatePrice(this.deps.coin, newCandle.c);
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
        entryBarIndex: this.entryBarIndex ?? this.findEntryBarIndex(candles, pos.openedAt),
        unrealizedPnl: pos.unrealizedPnl,
        fills: [],
      },
      higherTimeframes,
      dailyPnl: this.dailyPnl,
      tradesToday: this.tradesToday,
      barsSinceExit: this.barsSinceExit,
    });

    const exitSignal = this.deps.strategy.shouldExit(ctx);
    if (exitSignal?.exit) {
      log.info({ action: "exitTriggered", coin: this.deps.coin, direction: pos.direction, unrealizedPnl: pos.unrealizedPnl, comment: exitSignal.comment }, "Strategy exit triggered");
      const { hlClient, store } = this.deps.signalHandlerDeps;
      const closeSide = pos.direction === "long" ? "sell" : "buy";
      const exitResult = await hlClient.placeMarketOrder(this.deps.coin, closeSide === "buy", pos.size);

      // Record exit order + fill so position appears as CLOSED in history
      const signalId = pos.signalId > 0 ? pos.signalId : null;
      const exitTs = new Date().toISOString();
      const exitPrice = candles[index].c;
      const exitOrderId = store.insertOrder({
        signal_id: signalId,
        hl_order_id: exitResult.orderId,
        coin: this.deps.coin,
        side: closeSide,
        size: pos.size,
        price: exitPrice,
        order_type: "market",
        tag: "exit",
        status: "filled",
        mode: this.deps.config.mode,
        filled_at: exitTs,
      });
      store.insertFill({
        order_id: exitOrderId,
        price: exitPrice,
        size: pos.size,
        fee: 0,
        timestamp: exitTs,
      });

      this.deps.positionBook.close(this.deps.coin);
      const totalPnl = pos.unrealizedPnl + pos.cumulativeFunding;
      if (signalId != null && pos.cumulativeFunding !== 0) {
        store.updateSignalFunding(signalId, pos.cumulativeFunding);
      }
      this.deps.eventLog.append({
        type: "position_closed",
        timestamp: exitTs,
        data: {
          coin: this.deps.coin,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          pnl: totalPnl,
          cumulativeFunding: pos.cumulativeFunding,
          reason: exitSignal.comment ?? "strategy_exit",
        },
      }).catch(() => {});
      this.barsSinceExit = 0;
      this.lastExitLevel = null;
      this.trailingSlOid = null;
      this.entryBarIndex = null;
      this.dailyPnl += totalPnl;
      this.deps.orchestrator?.recordClose(this.getModuleId(), totalPnl);
      log.info({
        action: "positionClosed",
        coin: this.deps.coin,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        pnl: totalPnl,
        cumulativeFunding: pos.cumulativeFunding,
        exitReason: exitSignal.comment ?? "strategy_exit",
      }, "Position closed");
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

    // Breakeven guard: only place trailing SL once it locks in profit (or at
    // least breakeven). Without this, the trailing SL can be hit before the
    // fixed SL, causing a guaranteed loss on the trade.
    const isAtBreakeven =
      (pos.direction === "long" && newLevel >= pos.entryPrice) ||
      (pos.direction === "short" && newLevel <= pos.entryPrice);

    const movedFavorably = this.lastExitLevel !== null && (
      (pos.direction === "long" && newLevel > this.lastExitLevel) ||
      (pos.direction === "short" && newLevel < this.lastExitLevel)
    );

    const isFirstLevel = this.lastExitLevel === null;
    const shouldPlace = isMoreProtective && isAtBreakeven && (movedFavorably || isFirstLevel);

    if (!isAtBreakeven && isMoreProtective) {
      log.debug(
        { action: "trailingSlBelowBreakeven", coin: this.deps.coin, level: newLevel, entryPrice: pos.entryPrice },
        "Trailing SL level below breakeven — skipping placement",
      );
    }

    if (movedFavorably && isAtBreakeven) {
      log.info({ action: "trailingSlMoved", coin: this.deps.coin, oldLevel: this.lastExitLevel, newLevel }, "Trailing SL moved");
      Promise.resolve(
        this.deps.signalHandlerDeps.alertsClient.notifyTrailingSlMoved(
          this.deps.coin,
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
    const coin = this.deps.coin;
    const truncatedLevel = truncatePrice(newLevel);
    const oldOid = this.trailingSlOid;

    try {
      const result = await hlClient.placeStopOrder(
        coin,
        pos.direction === "short",
        pos.size,
        truncatedLevel,
        true,
      );

      // Update in-memory state FIRST — these must succeed even if SQLite fails,
      // otherwise the daemon loses track of the HL order and the explorer shows no TSL line.
      this.trailingSlOid = Number(result.orderId);
      this.deps.positionBook.updateTrailingStopLoss(coin, truncatedLevel);
      log.info({ action: "trailingSlPlaced", coin, level: truncatedLevel, oid: result.orderId }, "Trailing SL order placed");

      const signalId = pos.signalId > 0 ? pos.signalId : null;
      try {
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
      } catch (dbErr) {
        log.warn({ action: "trailingSlDbInsertFailed", coin, oid: result.orderId, err: dbErr }, "Trailing SL placed on HL but SQLite insert failed");
      }

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

  private async expirePendingEntry(): Promise<void> {
    const pendingEntryBook = this.deps.signalHandlerDeps.pendingEntryBook;
    if (!pendingEntryBook) return;

    const entry = pendingEntryBook.get(this.deps.coin);
    if (!entry || entry.expiresAt > Date.now()) return;

    pendingEntryBook.remove(this.deps.coin);
    log.info({ action: "pendingEntryExpired", coin: this.deps.coin, hlOrderId: entry.hlOrderId }, "GTC entry expired — cancelling order");

    try {
      await this.deps.signalHandlerDeps.hlClient.cancelOrder(this.deps.coin, entry.hlOrderId);
      log.info({ action: "pendingEntryCancelled", coin: this.deps.coin, oid: entry.hlOrderId }, "Expired GTC entry order cancelled on HL");
    } catch (err) {
      log.warn({ action: "pendingEntryCancelFailed", coin: this.deps.coin, oid: entry.hlOrderId, err }, "Failed to cancel expired GTC entry (may already be filled/cancelled)");
    }

    // Mark the entry order as cancelled in SQLite
    const orderRecord = this.deps.signalHandlerDeps.store.getOrderByHlOid(String(entry.hlOrderId));
    if (orderRecord?.id) {
      this.deps.signalHandlerDeps.store.updateOrderStatus(orderRecord.id, "cancelled");
    }

    this.deps.signalHandlerDeps.store.updateSignalOutcome(entry.signalId, "no_fill", "GTC entry expired (timeout)");

    await this.deps.eventLog.append({
      type: "gtc_entry_expired",
      timestamp: new Date().toISOString(),
      data: { coin: this.deps.coin, hlOrderId: entry.hlOrderId, signalId: entry.signalId },
    });
  }

  private async checkEntry(
    candles: Candle[],
    index: number,
    higherTimeframes: Record<string, Candle[]>,
    currentPrice: number,
  ): Promise<void> {
    this.barsSinceExit++;

    // ── Gate checks (collect block reason, don't return early) ──
    let gateBlockReason: string | null = null;

    if (this.deps.orchestrator) {
      const gate = this.deps.orchestrator.canSignal(this.getModuleId());
      if (!gate.allowed) {
        gateBlockReason = gate.reason ?? "Orchestrator blocked";
        log.debug({ action: "orchestratorBlocked", reason: gate.reason }, "Blocked by orchestrator");
      }
    }

    if (!gateBlockReason) {
      const tradingAllowed = canTrade({
        barsSinceExit: this.barsSinceExit,
        cooldownBars: this.deps.config.guardrails.cooldownBars,
        dailyPnl: this.deps.orchestrator?.getDailyPnl() ?? this.dailyPnl,
        maxDailyLossUsd: this.deps.config.guardrails.maxDailyLossR * this.deps.config.sizing.riskPerTradeUsd,
        tradesToday: this.tradesToday,
        maxTradesPerDay: this.deps.config.guardrails.maxTradesPerDay,
        maxGlobalTradesDay: this.deps.config.guardrails.maxTradesPerDay,
      });

      if (!tradingAllowed) {
        gateBlockReason = `Trading blocked (cooldown=${this.barsSinceExit}/${this.deps.config.guardrails.cooldownBars}, trades=${this.tradesToday})`;
        log.debug({
          action: "tradingBlocked",
          coin: this.deps.coin,
          barsSinceExit: this.barsSinceExit,
          tradesToday: this.tradesToday,
          dailyPnl: this.dailyPnl,
        }, "Trading blocked by guardrails");
      }
    }

    // ── Always run strategy to capture would-be signals ──
    const ctx = buildContext({
      candles,
      index,
      position: null,
      higherTimeframes,
      dailyPnl: this.dailyPnl,
      tradesToday: this.tradesToday,
      barsSinceExit: this.barsSinceExit,
      diagnosticsEnabled: true,
    });

    const signal = this.deps.strategy.onCandle(ctx);
    this.lastSignalResult = { t: candles[index].t, hadSignal: signal !== null };
    if (!signal) {
      log.debug(
        {
          action: "noSignal",
          coin: this.deps.coin,
          conditions: ctx.getConditions(),
          indicators: ctx.getIndicators(),
        },
        "onCandle returned null",
      );
      return;
    }

    // If gates blocked, record the signal that would have been generated
    if (gateBlockReason) {
      this.signalCounter++;
      const gateAlertId = `runner-gate-${Date.now()}-${this.signalCounter}`;
      this.deps.signalHandlerDeps.store.insertSignal({
        alert_id: gateAlertId,
        source: "strategy-runner",
        asset: this.deps.coin,
        side: signal.direction.toUpperCase(),
        entry_price: signal.entryPrice,
        stop_loss: signal.stopLoss,
        take_profits: JSON.stringify(signal.takeProfits ?? []),
        risk_check_passed: 0,
        risk_check_reason: gateBlockReason,
        strategy_name: this.deps.strategyConfigName,
        outcome: "blocked",
        outcome_reason: gateBlockReason,
      });
      return;
    }

    log.info({
      action: "signalGenerated",
      coin: this.deps.coin,
      direction: signal.direction,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfits: signal.takeProfits.map((tp) => tp.price),
      comment: signal.comment,
      barsSinceExit: this.barsSinceExit,
      tradesToday: this.tradesToday,
    }, "Strategy signal generated");

    // Deconfliction: buffer same-bar signals across runners for the same coin
    if (this.deps.orchestrator) {
      const resolution = await this.deps.orchestrator.proposeSignal(
        this.getModuleId(), this.deps.coin, candles[index].t, signal.direction,
      );
      if (!resolution.proceed) {
        log.info({ action: "signalDeconflicted", reason: resolution.reason }, "Signal deconflicted");
        this.signalCounter++;
        const deconflictAlertId = `runner-deconf-${Date.now()}-${this.signalCounter}`;
        this.deps.signalHandlerDeps.store.insertSignal({
          alert_id: deconflictAlertId,
          source: "strategy-runner",
          asset: this.deps.coin,
          side: signal.direction.toUpperCase(),
          entry_price: signal.entryPrice,
          stop_loss: signal.stopLoss,
          take_profits: JSON.stringify(signal.takeProfits ?? []),
          risk_check_passed: 0,
          risk_check_reason: resolution.reason ?? "Signal deconflicted",
          strategy_name: this.deps.strategyConfigName,
          outcome: "blocked",
          outcome_reason: resolution.reason ?? "Signal deconflicted",
        });
        return;
      }
    }

    this.signalCounter++;
    const alertId = `runner-${Date.now()}-${this.signalCounter}`;

    const result = await handleSignal(
      {
        signal,
        currentPrice,
        source: "strategy-runner",
        alertId,
        coin: this.deps.coin,
        leverage: this.deps.leverage,
        autoTradingEnabled: this.deps.autoTradingEnabled,
        strategyName: this.deps.strategyConfigName,
        dailyLossOverride: this.deps.orchestrator?.getDailyPnl(),
      },
      this.deps.signalHandlerDeps,
    );

    if (result.success) {
      this.tradesToday++;
      this.deps.orchestrator?.recordEntry(this.getModuleId());
      this.lastExitLevel = null;
      this.trailingSlOid = null;
      this.entryBarIndex = index;
    }
  }

  /** Find the candle index closest to the position's openedAt timestamp. */
  private findEntryBarIndex(candles: Candle[], openedAt: string): number {
    const entryTs = new Date(openedAt).getTime();
    // Binary-style: find first candle with t >= entryTs
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].t >= entryTs) return i;
    }
    // Entry was after all candles — use last index
    return candles.length - 1;
  }

  private reportSqueezeState(candles: Candle[], barTs: number): void {
    if (!this.deps.orchestrator) return;
    if (candles.length < 20) return;

    const closes = candles.map((c) => c.c);
    const bb = bollingerBands(closes, 20, 2.0);
    const kc = keltner(candles, 20, 20, 1.5);
    const squeeze = detectSqueeze(bb, kc, 4);
    const lastIndex = squeeze.squeezeActive.length - 1;

    this.deps.orchestrator.reportSqueeze(
      this.deps.coin,
      squeeze.squeezeActive[lastIndex],
      barTs,
    );
  }

  private buildHigherTimeframes(candles: Candle[]): Record<string, Candle[]> {
    const higherTimeframes: Record<string, Candle[]> = {};
    if (this.deps.strategy.requiredTimeframes) {
      for (const tf of this.deps.strategy.requiredTimeframes) {
        higherTimeframes[tf] = aggregateCandles(
          candles,
          this.deps.interval,
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
        log.error({ action: "processClosedCandle", coin: this.deps.coin, err }, "Error processing closed candle");
        await this.deps.eventLog.append({
          type: "error",
          timestamp: new Date().toISOString(),
          data: { message: (err as Error).message, stack: (err as Error).stack },
        });
      }
    });

    this.deps.streamer.on("candle:tick", (candle) => {
      if (!this.running) return;
      const tickPos = this.deps.positionBook.get(this.deps.coin);
      if (tickPos) this.deps.positionBook.updatePrice(this.deps.coin, candle.c);
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

  getCoin(): string {
    return this.deps.coin;
  }

  getInterval(): CandleInterval {
    return this.deps.interval;
  }

  getStrategyName(): string {
    return this.deps.strategyConfigName;
  }

  getModuleId(): string {
    return `${this.deps.coin}:${this.deps.strategyConfigName}`;
  }

  getLastSignalResult(): { t: number; hadSignal: boolean } | null {
    return this.lastSignalResult;
  }

  setAutoTradingEnabled(enabled: boolean): void {
    this.deps.autoTradingEnabled = enabled;
  }
}
