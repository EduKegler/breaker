import type { HlClient } from "../types/hl-client.js";
import type { SqliteStore } from "../adapters/sqlite-store.js";
import type { EventLog } from "../adapters/event-log.js";
import type { PositionBook } from "../domain/position-book.js";
import { truncateSize } from "@breaker/kit";
import { logger } from "../lib/logger.js";

const log = logger.createChild("protectionOrders");

export interface ProtectionOrdersDeps {
  hlClient: HlClient;
  store: SqliteStore;
  eventLog: EventLog;
  positionBook: PositionBook;
}

export interface ProtectionOrdersInput {
  coin: string;
  signalId: number;
  direction: "long" | "short";
  entrySide: "buy" | "sell";
  actualSize: number;
  actualPrice: number;
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
  leverage: number;
  mode: string;
  strategyName: string | null;
  szDecimals: number;
}

export async function placeProtectionOrders(
  input: ProtectionOrdersInput,
  deps: ProtectionOrdersDeps,
): Promise<void> {
  const { hlClient, store, positionBook } = deps;
  const {
    coin, signalId, direction, entrySide, actualSize, actualPrice,
    stopLoss, takeProfits, leverage, mode, strategyName, szDecimals,
  } = input;

  // SL closes the position: opposite side to entry, reduceOnly prevents
  // accidentally opening a new position if the original was already closed.
  // If SL placement fails, immediately close the entry to avoid an unprotected position.
  let slResult: Awaited<ReturnType<typeof hlClient.placeStopOrder>>;
  try {
    slResult = await hlClient.placeStopOrder(
      coin,
      entrySide === "sell",
      actualSize,
      stopLoss,
      true,
    );
  } catch (slErr) {
    log.error({ action: "slPlacementFailed", signalId, err: slErr }, "SL placement failed after entry — rolling back");

    try {
      await hlClient.placeMarketOrder(coin, entrySide !== "buy", actualSize);
      log.info({ action: "entryRolledBack", signalId }, "Entry rolled back (position closed)");
    } catch (closeErr) {
      // Worst case: position stuck on HL without SL AND without local tracking.
      // Hydrate into positionBook so reconcile loop can see it.
      if (!positionBook.isFlat(coin)) {
        positionBook.close(coin);
      }
      positionBook.open({
        coin,
        direction,
        entryPrice: actualPrice,
        size: actualSize,
        stopLoss: 0,
        takeProfits: [],
        liquidationPx: null,
        trailingStopLoss: null,
        leverage,
        openedAt: new Date().toISOString(),
        signalId,
        strategyName,
      });
      log.error({ action: "rollbackFailed", signalId, err: closeErr }, "CRITICAL: position stuck on HL without SL, hydrated locally");
    }

    throw slErr;
  }

  log.info({ action: "slPlaced", signalId, hlOrderId: slResult.orderId, triggerPrice: stopLoss }, "Stop loss placed");
  store.insertOrder({
    signal_id: signalId,
    hl_order_id: slResult.orderId,
    coin,
    side: entrySide === "buy" ? "sell" : "buy",
    size: actualSize,
    price: stopLoss,
    order_type: "stop",
    tag: "sl",
    status: "pending",
    mode,
    filled_at: null,
  });

  // TP partially closes: opposite side, reduceOnly=true for same reason as SL.
  // TP failure is non-critical: the SL protects the position. Log and continue.
  let allocatedTpSize = 0;
  for (let i = 0; i < takeProfits.length; i++) {
    const tp = takeProfits[i];
    const isLast = i === takeProfits.length - 1;
    const cumulativePct = allocatedTpSize / actualSize + tp.pctOfPosition;
    const tpSize = isLast && cumulativePct >= 1 - 1e-9
      ? actualSize - allocatedTpSize
      : truncateSize(actualSize * tp.pctOfPosition, szDecimals);
    allocatedTpSize += tpSize;
    try {
      const tpResult = await hlClient.placeTpOrder(
        coin,
        entrySide === "sell",
        tpSize,
        tp.price,
        true,
      );

      log.info({ action: "tpPlaced", signalId, hlOrderId: tpResult.orderId, price: tp.price, tag: `tp${i + 1}` }, "Take profit placed");
      store.insertOrder({
        signal_id: signalId,
        hl_order_id: tpResult.orderId,
        coin,
        side: entrySide === "buy" ? "sell" : "buy",
        size: tpSize,
        price: tp.price,
        order_type: "trigger",
        tag: `tp${i + 1}`,
        status: "pending",
        mode,
        filled_at: null,
      });
    } catch (tpErr) {
      log.warn({ action: "tpPlacementFailed", signalId, tag: `tp${i + 1}`, err: tpErr }, "TP placement failed (position still protected by SL)");
    }
  }

  // Update position book.
  // The reconcile loop may have already hydrated this position (race: entry fills
  // on HL → reconcile sees it → hydrates with stopLoss=0 before we reach this line).
  // Close the stale hydrated entry and re-open with accurate data.
  if (!positionBook.isFlat(coin)) {
    positionBook.close(coin);
  }
  positionBook.open({
    coin,
    direction,
    entryPrice: actualPrice,
    size: actualSize,
    stopLoss,
    takeProfits,
    liquidationPx: null,
    trailingStopLoss: null,
    leverage,
    openedAt: new Date().toISOString(),
    signalId,
    strategyName,
  });
}
