import type { PendingEntryBook } from "../domain/pending-entry-book.js";
import type { PositionBook } from "../domain/position-book.js";
import type { HlClient } from "../types/hl-client.js";
import type { SqliteStore } from "../adapters/sqlite-store.js";
import type { EventLog } from "../adapters/event-log.js";
import type { AlertsClient } from "../types/alerts-client.js";
import type { WsUserFill } from "../types/hl-event-stream.js";
import { placeProtectionOrders } from "./place-protection-orders.js";
import { logger } from "../lib/logger.js";

const log = logger.createChild("pendingFill");

export interface ProcessPendingFillDeps {
  pendingEntryBook: PendingEntryBook;
  positionBook: PositionBook;
  hlClient: HlClient;
  store: SqliteStore;
  eventLog: EventLog;
  alertsClient: AlertsClient;
  mode: string;
}

export async function processPendingFill(
  fill: WsUserFill,
  deps: ProcessPendingFillDeps,
): Promise<boolean> {
  const { pendingEntryBook, positionBook, hlClient, store, eventLog, alertsClient, mode } = deps;

  const pending = pendingEntryBook.findByOrderId(fill.oid);
  if (!pending) return false;

  const filledSize = parseFloat(fill.sz);
  const filledPrice = parseFloat(fill.px);

  log.info({
    action: "pendingFillReceived",
    coin: pending.coin,
    hlOrderId: fill.oid,
    filledSize,
    filledPrice,
    signalId: pending.signalId,
  }, "GTC entry fill received — placing protection orders");

  // Remove from pending book
  pendingEntryBook.remove(pending.coin);

  // Update entry order status in SQLite
  const entryOrder = store.getOrderByHlOid(String(fill.oid));
  if (entryOrder?.id) {
    store.updateOrderStatus(entryOrder.id, "filled", new Date(fill.time).toISOString());
    try {
      store.insertFill({
        order_id: entryOrder.id,
        price: filledPrice,
        size: filledSize,
        fee: parseFloat(fill.fee),
        timestamp: new Date(fill.time).toISOString(),
      });
    } catch (err) {
      log.warn({ oid: fill.oid, err }, "Failed to insert fill record (may be duplicate)");
    }
  }

  await eventLog.append({
    type: "gtc_entry_filled",
    timestamp: new Date().toISOString(),
    data: {
      signalId: pending.signalId,
      coin: pending.coin,
      hlOrderId: fill.oid,
      filledSize,
      filledPrice,
    },
  });

  const szDecimals = hlClient.getSzDecimals(pending.coin);

  // Place SL/TP and open position
  await placeProtectionOrders({
    coin: pending.coin,
    signalId: pending.signalId,
    direction: pending.direction,
    entrySide: pending.direction === "long" ? "buy" : "sell",
    actualSize: filledSize,
    actualPrice: filledPrice,
    stopLoss: pending.stopLoss,
    takeProfits: pending.takeProfits,
    leverage: pending.leverage,
    mode,
    strategyName: pending.strategyName,
    szDecimals,
  }, { hlClient, store, eventLog, positionBook });

  // Notify
  try {
    await alertsClient.notifyPositionOpened({
      coin: pending.coin,
      side: pending.direction === "long" ? "buy" : "sell",
      size: filledSize,
      entryPrice: filledPrice,
      stopLoss: pending.stopLoss,
      takeProfits: pending.takeProfits,
      direction: pending.direction,
      notionalUsd: filledSize * filledPrice,
      comment: pending.comment,
      entryType: "gtc",
    }, mode);
  } catch {
    log.warn({ coin: pending.coin }, "Failed to send notification for GTC fill");
  }

  log.info({
    action: "pendingFillComplete",
    coin: pending.coin,
    signalId: pending.signalId,
    direction: pending.direction,
    size: filledSize,
    price: filledPrice,
  }, "GTC entry processed — position opened with protection");

  return true;
}
