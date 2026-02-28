import type { HlClient, HlHistoricalOrder } from "../types/hl-client.js";

/**
 * Fetches historical order statuses, with parallel fallback via getOrderStatus
 * for trigger orders (SL/TP) that don't appear in getHistoricalOrders.
 */
export async function resolveHistoricalStatuses(
  hlClient: HlClient,
  walletAddress: string,
  oids: number[],
): Promise<Map<number, HlHistoricalOrder["status"]>> {
  const historicalOrders = await hlClient.getHistoricalOrders(walletAddress);
  const statusMap = new Map<number, HlHistoricalOrder["status"]>(
    historicalOrders.map((o) => [o.oid, o.status]),
  );

  const missingOids = oids.filter((oid) => !statusMap.has(oid));
  if (missingOids.length > 0) {
    const results = await Promise.all(
      missingOids.map((oid) => hlClient.getOrderStatus(walletAddress, oid)),
    );
    for (let i = 0; i < missingOids.length; i++) {
      if (results[i]) statusMap.set(missingOids[i], results[i]!.status);
    }
  }

  return statusMap;
}
