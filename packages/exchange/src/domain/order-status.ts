/**
 * Maps a Hyperliquid order status to our internal status.
 *
 * @param hlStatus - Status from HL historical orders API (filled, triggered, canceled, marginCanceled, rejected)
 *                   or from WS push (same values). May be undefined if order not found in HL.
 * @param positionExists - Whether a local position exists for this order's coin.
 * @returns Internal status string, or null if the order should be skipped (too recent / ambiguous).
 */
export function resolveOrderStatus(
  hlStatus: string | undefined,
  positionExists: boolean,
): "filled" | "cancelled" | "rejected" | null {
  if (hlStatus === "filled" || hlStatus === "triggered") {
    return "filled";
  }
  if (hlStatus === "canceled" || hlStatus === "marginCanceled") {
    return "cancelled";
  }
  if (hlStatus === "rejected") {
    return "rejected";
  }
  // Not found in HL — if no position exists, consider it cancelled
  if (!positionExists) {
    return "cancelled";
  }
  // Position still open, order might be too recent — skip
  return null;
}
