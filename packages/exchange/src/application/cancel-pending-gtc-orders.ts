import type { PendingEntryBook } from "../domain/pending-entry-book.js";
import type { HlClient } from "../types/hl-client.js";

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface CancelPendingGtcDeps {
  pendingEntryBook: PendingEntryBook;
  hlClient: HlClient;
  log: Logger;
}

/**
 * Cancel all pending GTC entry orders on the exchange.
 * Individual cancel failures are logged but do not prevent other cancellations.
 * Returns the number of successfully cancelled orders.
 */
export async function cancelPendingGtcOrders(deps: CancelPendingGtcDeps): Promise<number> {
  const { pendingEntryBook, hlClient, log } = deps;
  const pending = pendingEntryBook.getAll();
  if (pending.length === 0) return 0;

  log.info({ count: pending.length }, "Cancelling pending GTC orders before shutdown");

  let cancelled = 0;
  for (const entry of pending) {
    try {
      await hlClient.cancelOrder(entry.coin, entry.hlOrderId);
      pendingEntryBook.remove(entry.coin);
      cancelled++;
      log.info({ coin: entry.coin, oid: entry.hlOrderId }, "Cancelled pending GTC order on shutdown");
    } catch (err) {
      log.warn(
        { coin: entry.coin, oid: entry.hlOrderId, err },
        "Failed to cancel pending GTC order on shutdown (continuing)",
      );
    }
  }

  return cancelled;
}
