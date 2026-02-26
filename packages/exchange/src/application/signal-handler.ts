import type { Signal } from "@breaker/backtest";
import { signalToIntent, type OrderIntent } from "../domain/order-intent.js";
import { checkRisk, type RiskCheckInput } from "../domain/risk-engine.js";
import type { ExchangeConfig } from "../types/config.js";
import type { HlClient } from "../adapters/hyperliquid-client.js";
import type { SqliteStore } from "../adapters/sqlite-store.js";
import type { EventLog } from "../adapters/event-log.js";
import type { AlertsClient } from "../adapters/alerts-client.js";
import type { PositionBook } from "../domain/position-book.js";
import { randomUUID } from "node:crypto";

export interface SignalHandlerDeps {
  config: ExchangeConfig;
  hlClient: HlClient;
  store: SqliteStore;
  eventLog: EventLog;
  alertsClient: AlertsClient;
  positionBook: PositionBook;
}

export interface HandleSignalInput {
  signal: Signal;
  currentPrice: number;
  source: "strategy-runner" | "api" | "router";
  alertId?: string;
}

export interface HandleSignalResult {
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

  // Idempotency check
  if (store.hasSignal(alertId)) {
    return { success: false, signalId: -1, reason: "Duplicate alert_id" };
  }

  // Convert signal to order intent
  const intent = signalToIntent(signal, currentPrice, config.asset, config.sizing);

  if (intent.size <= 0) {
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
    return { success: false, signalId, reason: riskResult.reason!, intent };
  }

  // Set leverage before first trade
  await hlClient.setLeverage(
    config.asset,
    config.leverage,
    config.marginType === "cross",
  );

  // Place entry market order
  const entryResult = await hlClient.placeMarketOrder(
    config.asset,
    intent.side === "buy",
    intent.size,
  );

  const entryOrderId = store.insertOrder({
    signal_id: signalId,
    hl_order_id: entryResult.orderId,
    coin: config.asset,
    side: intent.side,
    size: intent.size,
    price: intent.entryPrice,
    order_type: "market",
    tag: "entry",
    status: "filled",
    mode: config.mode,
    filled_at: new Date().toISOString(),
  });

  await eventLog.append({
    type: "order_placed",
    timestamp: new Date().toISOString(),
    data: { signalId, orderId: entryOrderId, hlOrderId: entryResult.orderId, tag: "entry" },
  });

  // Place stop loss
  const slResult = await hlClient.placeStopOrder(
    config.asset,
    intent.side === "sell", // opposite side for SL
    intent.size,
    intent.stopLoss,
    true,
  );

  store.insertOrder({
    signal_id: signalId,
    hl_order_id: slResult.orderId,
    coin: config.asset,
    side: intent.side === "buy" ? "sell" : "buy",
    size: intent.size,
    price: intent.stopLoss,
    order_type: "stop",
    tag: "sl",
    status: "pending",
    mode: config.mode,
    filled_at: null,
  });

  // Place take profit orders
  for (let i = 0; i < intent.takeProfits.length; i++) {
    const tp = intent.takeProfits[i];
    const tpSize = intent.size * tp.pctOfPosition;
    const tpResult = await hlClient.placeLimitOrder(
      config.asset,
      intent.side === "sell", // opposite side for TP
      tpSize,
      tp.price,
      true,
    );

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
  }

  // Update position book
  positionBook.open({
    coin: config.asset,
    direction: intent.direction,
    entryPrice: intent.entryPrice,
    size: intent.size,
    stopLoss: intent.stopLoss,
    takeProfits: intent.takeProfits,
    openedAt: new Date().toISOString(),
    signalId,
  });

  await eventLog.append({
    type: "position_opened",
    timestamp: new Date().toISOString(),
    data: { signalId, coin: config.asset, direction: intent.direction, size: intent.size },
  });

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

  return { success: true, signalId, intent };
}
