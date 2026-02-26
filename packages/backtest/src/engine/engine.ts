import type { Candle, CandleInterval } from "../types/candle.js";
import type { Strategy, StrategyContext, Signal } from "../types/strategy.js";
import type { CompletedTrade, Order, Fill } from "../types/order.js";
import { intervalToMs } from "../types/candle.js";
import { PositionTracker } from "./position-tracker.js";
import { OrderManager, createOrderId, resetOrderIdCounter } from "./order-manager.js";
import { EquityCurve, type EquityPoint } from "./equity-curve.js";
import { applySlippage, calculateCommission, type ExecutionConfig, DEFAULT_EXECUTION } from "./execution-model.js";
import { buildContext as buildCtx, canTrade as checkCanTrade, createUtcDayFormatter } from "./engine-shared.js";

export type SizingMode = "risk" | "cash";

export interface BacktestConfig {
  initialCapital: number;
  riskPerTradeUsd: number;
  sizingMode: SizingMode;
  cashPerTrade: number;
  execution: ExecutionConfig;
  maxTradesPerDay: number;
  maxDailyLossR: number;
  maxGlobalTradesDay: number;
  cooldownBars: number;
  maxConsecutiveLosses: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 1000,
  riskPerTradeUsd: 10,
  sizingMode: "risk",
  cashPerTrade: 100,
  execution: DEFAULT_EXECUTION,
  maxTradesPerDay: 3,
  maxDailyLossR: 2,
  maxGlobalTradesDay: 5,
  cooldownBars: 4,
  maxConsecutiveLosses: 2,
};

export interface BacktestResult {
  trades: CompletedTrade[];
  equityPoints: EquityPoint[];
  totalPnl: number;
  maxDrawdownPct: number;
  finalEquity: number;
  barsProcessed: number;
}

/**
 * Aggregate lower-timeframe candles into higher-timeframe candles.
 */
export function aggregateCandles(
  candles: Candle[],
  sourceInterval: CandleInterval,
  targetInterval: CandleInterval,
): Candle[] {
  const sourceMs = intervalToMs(sourceInterval);
  const targetMs = intervalToMs(targetInterval);

  if (targetMs <= sourceMs) return candles;

  const result: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketStart = 0;

  for (const c of candles) {
    const alignedTs = Math.floor(c.t / targetMs) * targetMs;

    if (bucket === null || alignedTs !== bucketStart) {
      if (bucket) result.push(bucket);
      bucketStart = alignedTs;
      bucket = { t: alignedTs, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: c.n };
    } else {
      bucket.h = Math.max(bucket.h, c.h);
      bucket.l = Math.min(bucket.l, c.l);
      bucket.c = c.c;
      bucket.v += c.v;
      bucket.n += c.n;
    }
  }

  if (bucket) result.push(bucket);
  return result;
}

/**
 * Run a backtest on a set of candles with a strategy.
 */
export function runBacktest(
  candles: Candle[],
  strategy: Strategy,
  config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
  sourceInterval: CandleInterval = "15m",
): BacktestResult {
  resetOrderIdCounter();

  const positionTracker = new PositionTracker();
  const orderManager = new OrderManager(config.execution);
  const equityCurve = new EquityCurve(config.initialCapital);

  // Pre-compute higher timeframe candles
  const higherTimeframes: Record<string, Candle[]> = {};
  if (strategy.requiredTimeframes) {
    for (const tf of strategy.requiredTimeframes) {
      higherTimeframes[tf] = aggregateCandles(
        candles,
        sourceInterval,
        tf as CandleInterval,
      );
    }
  }

  // Pre-compute indicators (strategies opt-in via init())
  strategy.init?.(candles, higherTimeframes);

  // State tracking
  let barsSinceExit = 999;
  let consecutiveLosses = 0;
  let dailyPnl = 0;
  let tradesToday = 0;
  let lastTradeDay = "";
  let lastEntryComment = "";
  let pendingExitComment = "";

  // UTC day-of-month for daily reset (matches Pine's dayofmonth(time, "UTC"))
  const utcDayFormatter = createUtcDayFormatter();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    // Use UTC day string for daily reset (Pine uses dayofmonth(time, "UTC"))
    const currentDay = utcDayFormatter.format(new Date(candle.t));

    // Daily reset
    if (currentDay !== lastTradeDay) {
      dailyPnl = 0;
      tradesToday = 0;
      consecutiveLosses = 0;
      lastTradeDay = currentDay;
    }

    // Step 1: Check pending stop/limit orders against candle
    const orderResult = orderManager.checkOrders(candle);

    for (const fill of orderResult.fills) {
      if (fill.tag === "entry") {
        // Entry fill
        const stopDist = calculateStopDistance(fill, orderManager);
        positionTracker.openPosition(
          fill.side === "buy" ? "long" : "short",
          fill,
          stopDist,
        );
        positionTracker.setEntryBarIndex(i);
      } else if (fill.tag === "signal") {
        // Deferred strategy exit fill (process_orders_on_close = false)
        if (!positionTracker.isFlat()) {
          const trade = positionTracker.closePosition(
            fill, i, "signal", pendingExitComment, lastEntryComment,
          );
          dailyPnl += trade.pnl;
          equityCurve.record(candle.t, i, trade.pnl);
          barsSinceExit = 0;
          if (trade.pnl < 0) consecutiveLosses++;
          else consecutiveLosses = 0;
          orderManager.clearOrders();
        }
      } else if (fill.tag === "sl" || fill.tag.startsWith("tp") || fill.tag === "trail") {
        // Exit fill
        if (!positionTracker.isFlat()) {
          const trade = handleExitFill(
            positionTracker,
            fill,
            i,
            lastEntryComment,
          );
          dailyPnl += trade.pnl;
          equityCurve.record(candle.t, i, trade.pnl);
          if (trade.pnl < 0) consecutiveLosses++;
          else consecutiveLosses = 0;
          // Only clear all orders when position is fully closed
          // After partial close, keep remaining SL/TP active
          if (positionTracker.isFlat()) {
            barsSinceExit = 0;
            orderManager.clearOrders();
          }
        }
      }
    }

    // Step 2: Update position MTM
    if (!positionTracker.isFlat()) {
      positionTracker.updateMtm(candle.c);
    }

    // Step 3: Strategy-driven exit check (deferred: process_orders_on_close = false)
    // Places a market order that fills at NEXT bar's open, matching Pine Script behavior.
    if (!positionTracker.isFlat() && strategy.shouldExit) {
      const ctx = buildCtx({
        candles, index: i, position: positionTracker.getPosition(),
        higherTimeframes, dailyPnl, tradesToday, barsSinceExit, consecutiveLosses,
      });
      const exitSignal = strategy.shouldExit(ctx);
      if (exitSignal?.exit) {
        const pos = positionTracker.getPosition()!;
        const closeSide = pos.direction === "long" ? "sell" : "buy";
        // Clear existing SL/TP orders (Pine: strategy.close overrides pending exits)
        orderManager.clearOrders();
        // Place market close order → fills at NEXT bar's open
        const closeOrder: Order = {
          id: createOrderId(),
          side: closeSide,
          type: "market",
          price: null,
          size: pos.size,
          reduceOnly: true,
          tag: "signal",
        };
        orderManager.addOrder(closeOrder, exitSignal.comment);
        pendingExitComment = exitSignal.comment;
      }
    }

    // Step 4: Entry signal (only if flat)
    if (positionTracker.isFlat()) {
      barsSinceExit++;

      const tradingAllowed = checkCanTrade({
        barsSinceExit, cooldownBars: config.cooldownBars,
        consecutiveLosses, maxConsecutiveLosses: config.maxConsecutiveLosses,
        dailyPnl, maxDailyLossR: config.maxDailyLossR,
        initialCapital: config.initialCapital,
        tradesToday, maxTradesPerDay: config.maxTradesPerDay,
        maxGlobalTradesDay: config.maxGlobalTradesDay,
      });

      if (tradingAllowed) {
        const ctx = buildCtx({
          candles, index: i, position: positionTracker.getPosition(),
          higherTimeframes, dailyPnl, tradesToday, barsSinceExit, consecutiveLosses,
        });
        const signal = strategy.onCandle(ctx);

        if (signal) {
          placeEntryOrders(
            signal, candle, config, orderManager,
          );
          lastEntryComment = signal.comment;
          tradesToday++;
        }
      }
    }

    // Record equity point even if no trade
    if (orderResult.fills.length === 0 && positionTracker.isFlat()) {
      equityCurve.record(candle.t, i, 0);
    }
  }

  // Force close any open position at last candle
  if (!positionTracker.isFlat() && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const pos = positionTracker.getPosition()!;
    const closeSide = pos.direction === "long" ? "sell" : "buy";
    const fillPrice = applySlippage(lastCandle.c, closeSide as "buy" | "sell", config.execution.slippageBps);
    const fee = calculateCommission(fillPrice, pos.size, config.execution.commissionPct);
    const fill: Fill = {
      orderId: createOrderId(),
      price: fillPrice,
      size: pos.size,
      side: closeSide as "buy" | "sell",
      fee,
      slippage: Math.abs(fillPrice - lastCandle.c) * pos.size,
      timestamp: lastCandle.t,
      tag: "eod",
    };
    const trade = positionTracker.closePosition(
      fill, candles.length - 1, "eod", "End of data", lastEntryComment,
    );
    equityCurve.record(lastCandle.t, candles.length - 1, trade.pnl);
  }

  const trades = positionTracker.getCompletedTrades();
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  return {
    trades,
    equityPoints: equityCurve.getPoints(),
    totalPnl,
    maxDrawdownPct: equityCurve.getMaxDrawdownPct(),
    finalEquity: equityCurve.getEquity(),
    barsProcessed: candles.length,
  };
}

function calculateStopDistance(fill: Fill, orderManager: OrderManager): number {
  const slOrder = orderManager.getPendingOrders().find((po) => po.order.tag === "sl");
  if (slOrder?.order.price) {
    return Math.abs(fill.price - slOrder.order.price);
  }
  return 0;
}

function handleExitFill(
  positionTracker: PositionTracker,
  fill: Fill,
  barIndex: number,
  entryComment: string,
): CompletedTrade {
  const pos = positionTracker.getPosition()!;
  const exitComment = fill.tag === "sl" ? "Stop loss" :
    fill.tag.startsWith("tp") ? `Take profit (${fill.tag})` :
    fill.tag === "trail" ? "Trailing stop" : fill.tag;

  if (fill.size >= pos.size) {
    return positionTracker.closePosition(fill, barIndex, fill.tag, exitComment, entryComment);
  }
  return positionTracker.partialClose(fill, barIndex, fill.tag, exitComment, entryComment);
}

function placeEntryOrders(
  signal: Signal,
  candle: Candle,
  config: BacktestConfig,
  orderManager: OrderManager,
): void {
  const entryPrice = signal.entryPrice ?? candle.c;
  const stopDist = Math.abs(entryPrice - signal.stopLoss);

  let size: number;
  if (config.sizingMode === "cash") {
    size = entryPrice > 0 ? config.cashPerTrade / entryPrice : 0;
  } else {
    size = stopDist > 0 ? config.riskPerTradeUsd / stopDist : 0;
  }

  if (size <= 0) return;

  const entrySide = signal.direction === "long" ? "buy" : "sell";
  const exitSide = signal.direction === "long" ? "sell" : "buy";

  // Entry order
  const entryOrder: Order = {
    id: createOrderId(),
    side: entrySide,
    type: signal.entryPrice === null ? "market" : "stop",
    price: signal.entryPrice,
    size,
    reduceOnly: false,
    tag: "entry",
  };
  orderManager.addOrder(entryOrder, signal.comment);

  // Stop loss order
  const slOrder: Order = {
    id: createOrderId(),
    side: exitSide,
    type: "stop",
    price: signal.stopLoss,
    size,
    reduceOnly: true,
    tag: "sl",
  };
  orderManager.addOrder(slOrder, signal.comment);

  // Take profit orders
  for (let j = 0; j < signal.takeProfits.length; j++) {
    const tp = signal.takeProfits[j];
    const tpSize = size * tp.pctOfPosition;
    const tpOrder: Order = {
      id: createOrderId(),
      side: exitSide,
      type: "limit",
      price: tp.price,
      size: tpSize,
      reduceOnly: true,
      tag: `tp${j + 1}`,
    };
    orderManager.addOrder(tpOrder, signal.comment);
  }
}
