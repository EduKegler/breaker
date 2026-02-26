import type { CompletedTrade } from "../types/order.js";
import type { FilterSimulations, HourSim, DaySim, RemoveAllSL } from "../types/metrics.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Simulate "what if we removed trades from hour X / day Y / all SL exits".
 */
export function computeFilterSimulations(trades: CompletedTrade[]): FilterSimulations {
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalTrades = trades.length;

  return {
    totalPnl,
    totalTrades,
    byHour: simulateByHour(trades, totalPnl, totalTrades),
    byDay: simulateByDay(trades, totalPnl, totalTrades),
    removeAllSL: simulateRemoveAllSL(trades, totalPnl, totalTrades),
  };
}

function simulateByHour(
  trades: CompletedTrade[],
  totalPnl: number,
  totalTrades: number,
): HourSim[] {
  // Group by entry hour UTC
  const hourBuckets = new Map<number, { count: number; pnl: number }>();

  for (const t of trades) {
    const hour = new Date(t.entryTimestamp).getUTCHours();
    const existing = hourBuckets.get(hour) ?? { count: 0, pnl: 0 };
    existing.count++;
    existing.pnl += t.pnl;
    hourBuckets.set(hour, existing);
  }

  return Array.from(hourBuckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([hour, bucket]) => ({
      hour,
      tradesRemoved: bucket.count,
      pnlDelta: -bucket.pnl,
      pnlAfter: totalPnl - bucket.pnl,
      tradesAfter: totalTrades - bucket.count,
    }));
}

function simulateByDay(
  trades: CompletedTrade[],
  totalPnl: number,
  totalTrades: number,
): DaySim[] {
  const dayBuckets = new Map<string, { count: number; pnl: number }>();

  for (const t of trades) {
    const day = DAY_NAMES[new Date(t.entryTimestamp).getUTCDay()];
    const existing = dayBuckets.get(day) ?? { count: 0, pnl: 0 };
    existing.count++;
    existing.pnl += t.pnl;
    dayBuckets.set(day, existing);
  }

  return Array.from(dayBuckets.entries()).map(([day, bucket]) => ({
    day,
    tradesRemoved: bucket.count,
    pnlDelta: -bucket.pnl,
    pnlAfter: totalPnl - bucket.pnl,
    tradesAfter: totalTrades - bucket.count,
  }));
}

function simulateRemoveAllSL(
  trades: CompletedTrade[],
  totalPnl: number,
  totalTrades: number,
): RemoveAllSL {
  const slTrades = trades.filter((t) => t.exitType === "sl");
  const slPnl = slTrades.reduce((s, t) => s + t.pnl, 0);

  return {
    tradesRemoved: slTrades.length,
    pnlDelta: -slPnl,
    pnlAfter: totalPnl - slPnl,
    tradesAfter: totalTrades - slTrades.length,
  };
}
