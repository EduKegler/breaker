import type { Signal } from "@breaker/backtest";
import { signalToIntent, type OrderIntent } from "../domain/signal-to-intent.js";
import { checkRisk, type RiskCheckInput } from "../domain/check-risk.js";
import type { ExchangeConfig } from "../types/config.js";
import type { HlClient } from "../types/hl-client.js";
import type { SqliteStore } from "../adapters/sqlite-store.js";
import type { EventLog } from "../adapters/event-log.js";
import type { AlertsClient } from "../types/alerts-client.js";
import type { PositionBook } from "../domain/position-book.js";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { truncateSize } from "../lib/truncate-size.js";
import { truncatePrice } from "../lib/truncate-price.js";

const log = logger.createChild("signalHandler");

export interface SignalHandlerDeps {
  config: ExchangeConfig;
  hlClient: HlClient;
  store: SqliteStore;
  eventLog: EventLog;
  alertsClient: AlertsClient;
  positionBook: PositionBook;
  onSignalProcessed?: () => void;
}

export interface HandleSignalInput {
  signal: Signal;
  currentPrice: number;
  source: "strategy-runner" | "api" | "router";
  alertId?: string;
}

interface HandleSignalResult {
  success: boolean;
  signalId: number;
  reason?: string;
  intent?: OrderIntent;
}

export async function handleSignal(
  input: HandleSignalInput,
  deps: SignalHandlerDeps,
): Promise<HandleSignalResult> {
  const { signal, currentPrice, source } = input;
  const { config, hlClient, store, eventLog, alertsClient, positionBook } = deps;
  const alertId = input.alertId ?? randomUUID();

  // Auto-trading kill switch: block strategy-runner entries when disabled
  if (source === "strategy-runner" && !config.autoTradingEnabled) {
    log.info({ action: "autoTradingDisabled", alertId }, "Auto-trading disabled — signal ignored");
    return { success: false, signalId: -1, reason: "Auto-trading disabled" };
  }

  // Idempotency check
  if (store.hasSignal(alertId)) {
    log.info({ action: "duplicateRejected", alertId }, "Duplicate signal rejected");
    return { success: false, signalId: -1, reason: "Duplicate alert_id" };
  }

  // Convert signal to order intent, then truncate to exchange precision.
  // This ensures values stored in positionBook/SQLite match what the exchange receives.
  const intent = signalToIntent(signal, currentPrice, config.asset, config.sizing);
  const szDecimals = hlClient.getSzDecimals(config.asset);
  intent.size = truncateSize(intent.size, szDecimals);
  intent.entryPrice = truncatePrice(intent.entryPrice);
  intent.stopLoss = truncatePrice(intent.stopLoss);
  intent.notionalUsd = intent.size * intent.entryPrice;

  if (intent.size <= 0) {
    log.info({ action: "zeroSizeRejected", entryPrice: intent.entryPrice, stopLoss: intent.stopLoss }, "Signal rejected: size is zero");
    const signalId = store.insertSignal({
      alert_id: alertId,
      source,
      asset: config.asset,
      side: signal.direction.toUpperCase(),
      entry_price: intent.entryPrice,
      stop_loss: intent.stopLoss,
      take_profits: JSON.stringify(intent.takeProfits),
      risk_check_passed: 0,
      risk_check_reason: "Size is zero",
    });
    return { success: false, signalId, reason: "Size is zero" };
  }

  // Risk check
  const riskInput: RiskCheckInput = {
    notionalUsd: intent.notionalUsd,
    leverage: config.leverage,
    openPositions: positionBook.count(),
    dailyLossUsd: Math.abs(store.getTodayRealizedPnl()),
    tradesToday: store.getTodayTradeCount(config.asset),
    entryPrice: intent.entryPrice,
    currentPrice,
  };
  const riskResult = checkRisk(riskInput, config.guardrails);

  const signalId = store.insertSignal({
    alert_id: alertId,
    source,
    asset: config.asset,
    side: signal.direction.toUpperCase(),
    entry_price: intent.entryPrice,
    stop_loss: intent.stopLoss,
    take_profits: JSON.stringify(intent.takeProfits),
    risk_check_passed: riskResult.passed ? 1 : 0,
    risk_check_reason: riskResult.reason,
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
    config.asset,
    config.leverage,
    config.marginType === "cross",
  );

  // Place entry limit IOC order (controlled slippage)
  const entryResult = await hlClient.placeEntryOrder(
    config.asset,
    intent.side === "buy",
    intent.size,
    currentPrice,
    config.entrySlippageBps,
  );

  // Determine actual filled size (truncate to exchange precision)
  const actualSize = truncateSize(entryResult.filledSize, szDecimals);

  // No fill or truncated to zero → abort
  if (actualSize <= 0) {
    store.insertOrder({
      signal_id: signalId,
      hl_order_id: entryResult.orderId,
      coin: config.asset,
      side: intent.side,
      size: intent.size,
      price: intent.entryPrice,
      order_type: "limit",
      tag: "entry",
      status: "cancelled",
      mode: config.mode,
      filled_at: null,
    });

    await eventLog.append({
      type: "entry_no_fill",
      timestamp: new Date().toISOString(),
      data: { signalId, alertId, hlOrderId: entryResult.orderId, requestedSize: intent.size },
    });

    log.info({ action: "entryNoFill", signalId, hlOrderId: entryResult.orderId, requestedSize: intent.size }, "Entry order got no fill (IOC expired)");
    return { success: false, signalId, reason: "Entry order not filled", intent };
  }

  if (actualSize < intent.size) {
    log.warn({ action: "entryPartialFill", signalId, requestedSize: intent.size, filledSize: actualSize }, "Entry partially filled — continuing with reduced size");
  }

  const actualPrice = entryResult.avgPrice || currentPrice;

  const entryOrderId = store.insertOrder({
    signal_id: signalId,
    hl_order_id: entryResult.orderId,
    coin: config.asset,
    side: intent.side,
    size: actualSize,
    price: actualPrice,
    order_type: "limit",
    tag: "entry",
    status: "filled",
    mode: config.mode,
    filled_at: new Date().toISOString(),
  });

  await eventLog.append({
    type: "order_placed",
    timestamp: new Date().toISOString(),
    data: { signalId, orderId: entryOrderId, hlOrderId: entryResult.orderId, tag: "entry", filledSize: actualSize, avgPrice: actualPrice },
  });

  // SL closes the position: opposite side to entry, reduceOnly prevents
  // accidentally opening a new position if the original was already closed.
  // If SL placement fails, immediately close the entry to avoid an unprotected position.
  let slResult: Awaited<ReturnType<typeof hlClient.placeStopOrder>>;
  try {
    slResult = await hlClient.placeStopOrder(
      config.asset,
      intent.side === "sell",
      actualSize,
      intent.stopLoss,
      true,
    );
  } catch (slErr) {
    log.error({ action: "slPlacementFailed", signalId, err: slErr }, "SL placement failed after entry — rolling back");

    try {
      await hlClient.placeMarketOrder(config.asset, intent.side !== "buy", actualSize);
      log.info({ action: "entryRolledBack", signalId }, "Entry rolled back (position closed)");
    } catch (closeErr) {
      // Worst case: position stuck on HL without SL AND without local tracking.
      // Hydrate into positionBook so reconcile loop can see it.
      // Reconcile may have already hydrated it — close stale entry first.
      if (!positionBook.isFlat(config.asset)) {
        positionBook.close(config.asset);
      }
      positionBook.open({
        coin: config.asset,
        direction: intent.direction,
        entryPrice: actualPrice,
        size: actualSize,
        stopLoss: 0,
        takeProfits: [],
        liquidationPx: null,
        trailingStopLoss: null,
        openedAt: new Date().toISOString(),
        signalId,
      });
      log.error({ action: "rollbackFailed", signalId, err: closeErr }, "CRITICAL: position stuck on HL without SL, hydrated locally");
    }

    throw slErr;
  }

  log.info({ action: "slPlaced", signalId, hlOrderId: slResult.orderId, triggerPrice: intent.stopLoss }, "Stop loss placed");
  store.insertOrder({
    signal_id: signalId,
    hl_order_id: slResult.orderId,
    coin: config.asset,
    side: intent.side === "buy" ? "sell" : "buy",
    size: actualSize,
    price: intent.stopLoss,
    order_type: "stop",
    tag: "sl",
    status: "pending",
    mode: config.mode,
    filled_at: null,
  });

  // TP partially closes: opposite side, reduceOnly=true for same reason as SL.
  // TP failure is non-critical: the SL protects the position. Log and continue.
  for (let i = 0; i < intent.takeProfits.length; i++) {
    const tp = intent.takeProfits[i];
    const tpSize = truncateSize(actualSize * tp.pctOfPosition, szDecimals);
    try {
      const tpResult = await hlClient.placeLimitOrder(
        config.asset,
        intent.side === "sell",
        tpSize,
        tp.price,
        true,
      );

      log.info({ action: "tpPlaced", signalId, hlOrderId: tpResult.orderId, price: tp.price, tag: `tp${i + 1}` }, "Take profit placed");
      store.insertOrder({
        signal_id: signalId,
        hl_order_id: tpResult.orderId,
        coin: config.asset,
        side: intent.side === "buy" ? "sell" : "buy",
        size: tpSize,
        price: tp.price,
        order_type: "limit",
        tag: `tp${i + 1}`,
        status: "pending",
        mode: config.mode,
        filled_at: null,
      });
    } catch (tpErr) {
      log.warn({ action: "tpPlacementFailed", signalId, tag: `tp${i + 1}`, err: tpErr }, "TP placement failed (position still protected by SL)");
    }
  }

  // Update position book.
  // The reconcile loop may have already hydrated this position (race: entry order fills
  // on HL → reconcile sees it → hydrates with stopLoss=0 before we reach this line).
  // In that case, close the stale hydrated entry and re-open with accurate data.
  if (!positionBook.isFlat(config.asset)) {
    positionBook.close(config.asset);
  }
  positionBook.open({
    coin: config.asset,
    direction: intent.direction,
    entryPrice: actualPrice,
    size: actualSize,
    stopLoss: intent.stopLoss,
    takeProfits: intent.takeProfits,
    liquidationPx: null,
    trailingStopLoss: null,
    openedAt: new Date().toISOString(),
    signalId,
  });

  await eventLog.append({
    type: "position_opened",
    timestamp: new Date().toISOString(),
    data: { signalId, coin: config.asset, direction: intent.direction, size: actualSize, avgPrice: actualPrice },
  });

  log.info({
    action: "positionOpened",
    signalId,
    coin: config.asset,
    direction: intent.direction,
    size: actualSize,
    entryPrice: actualPrice,
    stopLoss: intent.stopLoss,
    takeProfits: intent.takeProfits.map((tp) => tp.price),
    source,
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

  return { success: true, signalId, intent };
}
