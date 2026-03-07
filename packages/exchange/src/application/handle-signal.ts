import type { Signal } from "@breaker/backtest";
import { signalToIntent, type OrderIntent } from "../domain/signal-to-intent.js";
import { checkRisk, type RiskCheckInput } from "../domain/check-risk.js";
import { placeProtectionOrders } from "./place-protection-orders.js";
import type { ExchangeConfig } from "../types/config.js";
import type { HlClient } from "../types/hl-client.js";
import type { SqliteStore } from "../adapters/sqlite-store.js";
import type { EventLog } from "../adapters/event-log.js";
import type { AlertsClient } from "../types/alerts-client.js";
import type { PositionBook } from "../domain/position-book.js";
import type { PendingEntryBook } from "../domain/pending-entry-book.js";
import { randomUUID } from "node:crypto";
import { truncateSize, truncatePrice } from "@breaker/kit";
import { logger } from "../lib/logger.js";

const log = logger.createChild("signalHandler");

export interface SignalHandlerDeps {
  config: ExchangeConfig;
  hlClient: HlClient;
  store: SqliteStore;
  eventLog: EventLog;
  alertsClient: AlertsClient;
  positionBook: PositionBook;
  pendingEntryBook?: PendingEntryBook;
  onSignalProcessed?: () => void;
}

export interface HandleSignalInput {
  signal: Signal;
  currentPrice: number;
  source: "strategy-runner" | "api" | "router";
  alertId?: string;
  coin: string;
  leverage: number;
  autoTradingEnabled: boolean;
  strategyName?: string;
  /** When provided, overrides store.getTodayRealizedPnl() for the risk check.
   *  Strategy-runner passes the orchestrator's in-memory daily PnL here. */
  dailyLossOverride?: number;
}

interface HandleSignalResult {
  success: boolean;
  signalId: number;
  reason?: string;
  intent?: OrderIntent;
}

// Synchronous guard: prevents two concurrent handleSignal calls for the same coin
// from both passing isFlat() before either reaches positionBook.open().
const pendingCoins = new Set<string>();

export async function handleSignal(
  input: HandleSignalInput,
  deps: SignalHandlerDeps,
): Promise<HandleSignalResult> {
  const { signal, currentPrice, source, coin, leverage, autoTradingEnabled } = input;
  const { config, hlClient, store, eventLog, alertsClient, positionBook } = deps;
  const alertId = input.alertId ?? randomUUID();

  // Auto-trading kill switch: block strategy-runner entries when disabled
  if (source === "strategy-runner" && !autoTradingEnabled) {
    log.info({ action: "autoTradingDisabled", alertId, coin }, "Auto-trading disabled — signal ignored");
    const signalId = store.insertSignal({
      alert_id: alertId,
      source,
      asset: coin,
      side: signal.direction.toUpperCase(),
      entry_price: signal.entryPrice,
      stop_loss: signal.stopLoss,
      take_profits: JSON.stringify(signal.takeProfits ?? []),
      risk_check_passed: 0,
      risk_check_reason: "Auto-trading disabled",
      strategy_name: input.strategyName ?? null,
      outcome: "blocked",
      outcome_reason: "Auto-trading disabled",
    });
    await eventLog.append({
      type: "auto_trading_blocked",
      timestamp: new Date().toISOString(),
      data: { alertId, coin, direction: signal.direction, source, signalId },
    });
    return { success: false, signalId, reason: "Auto-trading disabled" };
  }

  // Idempotency check
  if (store.hasSignal(alertId)) {
    log.info({ action: "duplicateRejected", alertId }, "Duplicate signal rejected");
    return { success: false, signalId: -1, reason: "Duplicate alert_id" };
  }

  // Race condition guard: first signal wins per coin
  const hasPendingGtc = deps.pendingEntryBook?.has(coin) ?? false;
  if (pendingCoins.has(coin) || !positionBook.isFlat(coin) || hasPendingGtc) {
    log.info({ action: "coinBusy", coin, alertId, hasPendingGtc }, "Position already open or pending for coin");
    const signalId = store.insertSignal({
      alert_id: alertId,
      source,
      asset: coin,
      side: signal.direction.toUpperCase(),
      entry_price: signal.entryPrice,
      stop_loss: signal.stopLoss,
      take_profits: JSON.stringify(signal.takeProfits ?? []),
      risk_check_passed: 0,
      risk_check_reason: "Position already open/pending",
      strategy_name: input.strategyName ?? null,
      outcome: "blocked",
      outcome_reason: "Position already open/pending",
    });
    return { success: false, signalId, reason: "Position already open/pending" };
  }
  pendingCoins.add(coin);

  try {
    return await handleSignalInner(input, deps, alertId);
  } finally {
    pendingCoins.delete(coin);
  }
}

// Exported for testing: allows clearing the pendingCoins set between tests
export function clearPendingCoins(): void {
  pendingCoins.clear();
}

async function handleSignalInner(
  input: HandleSignalInput,
  deps: SignalHandlerDeps,
  alertId: string,
): Promise<HandleSignalResult> {
  const { signal, currentPrice, source, coin, leverage } = input;
  const { config, hlClient, store, eventLog, alertsClient, positionBook } = deps;
  const t0 = performance.now();

  // Convert signal to order intent, then truncate to exchange precision.
  // This ensures values stored in positionBook/SQLite match what the exchange receives.
  const intent = signalToIntent(signal, currentPrice, coin, config.sizing);
  const szDecimals = hlClient.getSzDecimals(coin);
  intent.size = truncateSize(intent.size, szDecimals);
  intent.entryPrice = truncatePrice(intent.entryPrice);
  intent.stopLoss = truncatePrice(intent.stopLoss);
  intent.notionalUsd = intent.size * intent.entryPrice;

  if (intent.size <= 0) {
    log.info({ action: "zeroSizeRejected", entryPrice: intent.entryPrice, stopLoss: intent.stopLoss }, "Signal rejected: size is zero");
    const signalId = store.insertSignal({
      alert_id: alertId,
      source,
      asset: coin,
      side: signal.direction.toUpperCase(),
      entry_price: intent.entryPrice,
      stop_loss: intent.stopLoss,
      take_profits: JSON.stringify(intent.takeProfits),
      risk_check_passed: 0,
      risk_check_reason: "Size is zero",
      strategy_name: input.strategyName ?? null,
      outcome: "rejected",
      outcome_reason: "Size is zero",
    });
    return { success: false, signalId, reason: "Size is zero" };
  }

  // Risk check — prefer orchestrator's in-memory PnL, but sanity-check against DB.
  // If the override diverges wildly from the DB value, fall back to DB to prevent
  // phantom blocks from stale in-memory state (e.g. after rapid daemon restarts).
  const sqlPnl = store.getTodayRealizedPnl();
  let dailyLossUsd: number;
  if (input.dailyLossOverride != null) {
    const overrideAbs = Math.abs(input.dailyLossOverride);
    const sqlAbs = Math.abs(sqlPnl);
    const divergence = Math.abs(overrideAbs - sqlAbs);
    const maxDailyLoss = config.guardrails.maxDailyLossR * config.sizing.riskPerTradeUsd;
    if (divergence > maxDailyLoss * 2) {
      log.warn({ dailyLossOverride: input.dailyLossOverride, sqlPnl, divergence },
        "dailyLossOverride diverges from DB — using DB value");
      dailyLossUsd = sqlAbs;
    } else {
      dailyLossUsd = overrideAbs;
    }
  } else {
    dailyLossUsd = Math.abs(sqlPnl);
  }

  const riskInput: RiskCheckInput = {
    notionalUsd: intent.notionalUsd,
    leverage,
    coinOpenPositions: positionBook.get(coin) ? 1 : 0,
    dailyLossUsd,
    tradesToday: store.getTodayGlobalTradeCount(),
    riskPerTradeUsd: config.sizing.riskPerTradeUsd,
    entryPrice: intent.entryPrice,
    currentPrice,
  };
  const riskResult = checkRisk(riskInput, config.guardrails);

  const signalId = store.insertSignal({
    alert_id: alertId,
    source,
    asset: coin,
    side: signal.direction.toUpperCase(),
    entry_price: intent.entryPrice,
    stop_loss: intent.stopLoss,
    take_profits: JSON.stringify(intent.takeProfits),
    risk_check_passed: riskResult.passed ? 1 : 0,
    risk_check_reason: riskResult.reason,
    strategy_name: input.strategyName ?? null,
    outcome: riskResult.passed ? null : "rejected",
    outcome_reason: riskResult.passed ? null : riskResult.reason ?? null,
  });

  await eventLog.append({
    type: riskResult.passed ? "risk_check_passed" : "risk_check_failed",
    timestamp: new Date().toISOString(),
    data: { signalId, alertId, riskResult },
  });

  if (!riskResult.passed) {
    log.info({ action: "riskCheckFailed", signalId, reason: riskResult.reason, riskInput }, "Risk check failed");
    return { success: false, signalId, reason: riskResult.reason!, intent };
  }

  // Leverage may have been reset externally (HL dashboard, API). Re-setting
  // on every trade is idempotent and ensures consistency.
  await hlClient.setLeverage(
    coin,
    leverage,
    config.marginType === "cross",
  );

  // ── GTC path (maker limit ALO) ────────────────────────────────────────
  if (intent.entryType === "gtc") {
    return handleGtcEntry(input, deps, intent, signalId, alertId, szDecimals, leverage, t0);
  }

  // ── IOC path (taker limit IOC) ──────────────────────────────────────
  return handleIocEntry(input, deps, intent, signalId, alertId, szDecimals, leverage, currentPrice, t0);
}

async function handleGtcEntry(
  input: HandleSignalInput,
  deps: SignalHandlerDeps,
  intent: OrderIntent,
  signalId: number,
  alertId: string,
  szDecimals: number,
  leverage: number,
  t0: number,
): Promise<HandleSignalResult> {
  const { coin, source } = input;
  const { config, hlClient, store, eventLog, positionBook } = deps;
  const pendingEntryBook = deps.pendingEntryBook;

  let gtcResult: Awaited<ReturnType<typeof hlClient.placeGtcEntryOrder>>;
  try {
    gtcResult = await hlClient.placeGtcEntryOrder(
      coin,
      intent.side === "buy",
      intent.size,
      intent.entryPrice,
    );
  } catch (entryErr) {
    log.error({
      action: "gtcEntryOrderError", signalId, coin, direction: intent.direction,
      size: intent.size, entryPrice: intent.entryPrice, err: entryErr,
      latencyMs: Math.round(performance.now() - t0),
    }, "GTC entry order failed");

    await eventLog.append({
      type: "entry_order_error",
      timestamp: new Date().toISOString(),
      data: { signalId, alertId, coin, direction: intent.direction, size: intent.size, entryPrice: intent.entryPrice, error: (entryErr as Error).message },
    });

    store.updateSignalOutcome(signalId, "error", (entryErr as Error).message);
    return { success: false, signalId, reason: (entryErr as Error).message, intent };
  }

  if (gtcResult.status === "rejected") {
    store.insertOrder({
      signal_id: signalId, hl_order_id: gtcResult.orderId, coin, side: intent.side,
      size: intent.size, price: intent.entryPrice, order_type: "limit", tag: "entry",
      status: "cancelled", mode: config.mode, filled_at: null,
    });

    await eventLog.append({
      type: "gtc_entry_rejected",
      timestamp: new Date().toISOString(),
      data: { signalId, alertId, coin, reason: "ALO rejected (would cross spread)" },
    });

    log.info({ action: "gtcEntryRejected", signalId, coin }, "ALO entry rejected — signal lost timing");
    store.updateSignalOutcome(signalId, "rejected", "ALO rejected (would cross spread)");
    return { success: false, signalId, reason: "ALO rejected (would cross spread)", intent };
  }

  if (gtcResult.status === "filled") {
    // Immediate fill — same as IOC from here on
    const actualSize = truncateSize(gtcResult.filledSize, szDecimals);
    if (actualSize <= 0) {
      log.warn({ action: "gtcFillTruncatedToZero", signalId }, "GTC filled but size truncated to zero");
      store.updateSignalOutcome(signalId, "error", "GTC fill truncated to zero");
      return { success: false, signalId, reason: "GTC fill truncated to zero", intent };
    }
    const actualPrice = gtcResult.avgPrice || intent.entryPrice;

    return finalizeEntry(input, deps, intent, signalId, alertId, szDecimals, leverage, actualSize, actualPrice, gtcResult.orderId, t0);
  }

  // status === "resting" → park in pending book
  const entryOrderId = store.insertOrder({
    signal_id: signalId, hl_order_id: gtcResult.orderId, coin, side: intent.side,
    size: intent.size, price: intent.entryPrice, order_type: "limit", tag: "entry",
    status: "pending", mode: config.mode, filled_at: null,
  });

  await eventLog.append({
    type: "gtc_entry_resting",
    timestamp: new Date().toISOString(),
    data: { signalId, alertId, coin, hlOrderId: gtcResult.orderId, price: intent.entryPrice, size: intent.size },
  });

  // 2 bars × 15min = 30min timeout
  const expiresAt = Date.now() + 30 * 60 * 1000;

  pendingEntryBook?.add({
    coin,
    hlOrderId: Number(gtcResult.orderId),
    direction: intent.direction,
    size: intent.size,
    price: intent.entryPrice,
    stopLoss: intent.stopLoss,
    takeProfits: intent.takeProfits,
    expiresAt,
    signalId,
    leverage,
    strategyName: input.strategyName ?? null,
    comment: intent.comment,
  });

  store.updateSignalOutcome(signalId, "resting", "GTC order resting on book");

  log.info({
    action: "gtcEntryResting", signalId, coin, hlOrderId: gtcResult.orderId,
    price: intent.entryPrice, expiresAt: new Date(expiresAt).toISOString(),
  }, "GTC entry resting on book — awaiting fill");

  deps.onSignalProcessed?.();
  return { success: true, signalId, intent };
}

async function handleIocEntry(
  input: HandleSignalInput,
  deps: SignalHandlerDeps,
  intent: OrderIntent,
  signalId: number,
  alertId: string,
  szDecimals: number,
  leverage: number,
  currentPrice: number,
  t0: number,
): Promise<HandleSignalResult> {
  const { coin } = input;
  const { config, hlClient, store, eventLog } = deps;

  // Fetch a fresh mid-price from the exchange to replace the potentially stale
  // candle-close price.  IOC limit orders are sensitive to the reference price:
  // a 3-second-old candle close in a fast market can already be far enough to
  // cause the limit to miss.  Falls back to candle close on any failure.
  let entryPrice = currentPrice;
  try {
    const mid = await hlClient.getMidPrice(coin);
    if (mid !== null) {
      entryPrice = mid;
      log.info({ action: "freshMidPrice", coin, mid, candleClose: currentPrice }, "Using fresh mid-price");
    }
  } catch (err) {
    log.warn({ action: "midPriceFailed", coin, err }, "Failed to fetch mid-price, using candle close");
  }

  // Place entry limit IOC order (controlled slippage)
  let entryResult: Awaited<ReturnType<typeof hlClient.placeEntryOrder>>;
  try {
    entryResult = await hlClient.placeEntryOrder(
      coin,
      intent.side === "buy",
      intent.size,
      entryPrice,
      config.entrySlippageBps,
    );
  } catch (entryErr) {
    log.error({
      action: "entryOrderError", signalId, coin, direction: intent.direction,
      size: intent.size, entryPrice: intent.entryPrice, err: entryErr,
      latencyMs: Math.round(performance.now() - t0),
    }, "Entry order failed (e.g. insufficient margin)");

    await eventLog.append({
      type: "entry_order_error",
      timestamp: new Date().toISOString(),
      data: { signalId, alertId, coin, direction: intent.direction, size: intent.size, entryPrice: intent.entryPrice, error: (entryErr as Error).message },
    });

    store.updateSignalOutcome(signalId, "error", (entryErr as Error).message);
    return { success: false, signalId, reason: (entryErr as Error).message, intent };
  }

  // Determine actual filled size (truncate to exchange precision)
  const actualSize = truncateSize(entryResult.filledSize, szDecimals);

  // No fill or truncated to zero → abort
  if (actualSize <= 0) {
    store.insertOrder({
      signal_id: signalId, hl_order_id: entryResult.orderId, coin, side: intent.side,
      size: intent.size, price: intent.entryPrice, order_type: "limit", tag: "entry",
      status: "cancelled", mode: config.mode, filled_at: null,
    });

    await eventLog.append({
      type: "entry_no_fill",
      timestamp: new Date().toISOString(),
      data: { signalId, alertId, hlOrderId: entryResult.orderId, requestedSize: intent.size },
    });

    log.info({ action: "entryNoFill", signalId, hlOrderId: entryResult.orderId, requestedSize: intent.size }, "Entry order got no fill (IOC expired)");
    store.updateSignalOutcome(signalId, "no_fill", "Entry order not filled (IOC expired)");
    return { success: false, signalId, reason: "Entry order not filled", intent };
  }

  if (actualSize < intent.size) {
    log.warn({ action: "entryPartialFill", signalId, requestedSize: intent.size, filledSize: actualSize }, "Entry partially filled — continuing with reduced size");
  }

  const actualPrice = entryResult.avgPrice || currentPrice;

  return finalizeEntry(input, deps, intent, signalId, alertId, szDecimals, leverage, actualSize, actualPrice, entryResult.orderId, t0);
}

async function finalizeEntry(
  input: HandleSignalInput,
  deps: SignalHandlerDeps,
  intent: OrderIntent,
  signalId: number,
  alertId: string,
  szDecimals: number,
  leverage: number,
  actualSize: number,
  actualPrice: number,
  hlOrderId: string,
  t0: number,
): Promise<HandleSignalResult> {
  const { coin, source } = input;
  const { config, hlClient, store, eventLog, alertsClient, positionBook } = deps;

  const entryOrderId = store.insertOrder({
    signal_id: signalId, hl_order_id: hlOrderId, coin, side: intent.side,
    size: actualSize, price: actualPrice, order_type: "limit", tag: "entry",
    status: "filled", mode: config.mode, filled_at: new Date().toISOString(),
  });

  // No placeholder fill here — real fills arrive via WS onFill in daemon.ts.
  // aggregatePositionHistory falls back to order.price/order.size when no fills exist.
  const entryFilledAt = new Date().toISOString();

  await eventLog.append({
    type: "order_placed",
    timestamp: entryFilledAt,
    data: { signalId, orderId: entryOrderId, hlOrderId, tag: "entry", filledSize: actualSize, avgPrice: actualPrice },
  });

  await placeProtectionOrders({
    coin, signalId, direction: intent.direction, entrySide: intent.side,
    actualSize, actualPrice, stopLoss: intent.stopLoss, takeProfits: intent.takeProfits,
    leverage, mode: config.mode, strategyName: input.strategyName ?? null, szDecimals,
  }, { hlClient, store, eventLog, positionBook });

  await eventLog.append({
    type: "position_opened",
    timestamp: new Date().toISOString(),
    data: { signalId, coin, direction: intent.direction, size: actualSize, avgPrice: actualPrice },
  });

  log.info({
    action: "positionOpened", signalId, coin, direction: intent.direction,
    size: actualSize, entryPrice: actualPrice, stopLoss: intent.stopLoss,
    takeProfits: intent.takeProfits.map((tp) => tp.price), source,
  }, "Position opened");

  // Notify via WhatsApp
  try {
    await alertsClient.notifyPositionOpened(intent, config.mode);
    await eventLog.append({
      type: "notification_sent",
      timestamp: new Date().toISOString(),
      data: { signalId, type: "position_opened" },
    });
  } catch {
    await eventLog.append({
      type: "notification_failed",
      timestamp: new Date().toISOString(),
      data: { signalId, type: "position_opened" },
    });
  }

  deps.onSignalProcessed?.();

  store.updateSignalOutcome(signalId, "executed");

  log.info({
    action: "handleSignalComplete", signalId, coin,
    direction: intent.direction, size: actualSize,
    latencyMs: Math.round(performance.now() - t0),
  }, "Signal flow completed");

  return { success: true, signalId, intent };
}
