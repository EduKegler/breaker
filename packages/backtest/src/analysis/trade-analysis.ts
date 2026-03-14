import type { CompletedTrade } from "../types/order.js";
import type {
  DirectionStats,
  ExitTypeStats,
  HourStats,
  DayStats,
  SessionName,
  SessionStats,
  TradeAnalysis,
} from "../types/metrics.js";
import { computeFilterSimulations } from "./filter-simulation.js";
import { computeWalkForward, computeRollingWalkForward } from "./walk-forward.js";
import { getSessionForTimestamp } from "./get-session-for-hour.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function analyzeTradeList(trades: CompletedTrade[]): TradeAnalysis {
  if (trades.length === 0) {
    return emptyAnalysis();
  }

  const byDirection = computeDirectionStats(trades);
  const byExitType = computeExitTypeStats(trades);
  const { avgBarsWinners, avgBarsLosers } = computeAvgBars(trades);
  const byDayOfWeek = computeDayStats(trades);
  const hourStats = computeHourStats(trades);
  const { bestHoursUTC, worstHoursUTC } = rankHours(hourStats);
  const { best3TradesPnl, worst3TradesPnl } = extremeTrades(trades);
  const filterSimulations = computeFilterSimulations(trades);
  const walkForward = computeWalkForward(trades);
  const rollingWalkForward = computeRollingWalkForward(trades);
  const bySession = computeSessionStats(trades);

  return {
    totalExitRows: trades.length,
    byDirection,
    byExitType,
    avgBarsWinners,
    avgBarsLosers,
    byDayOfWeek,
    bestHoursUTC,
    worstHoursUTC,
    best3TradesPnl,
    worst3TradesPnl,
    filterSimulations,
    walkForward,
    rollingWalkForward,
    bySession,
    byRegime: null,
  };
}

function emptyAnalysis(): TradeAnalysis {
  return {
    totalExitRows: 0,
    byDirection: {},
    byExitType: [],
    avgBarsWinners: null,
    avgBarsLosers: null,
    byDayOfWeek: {},
    bestHoursUTC: [],
    worstHoursUTC: [],
    best3TradesPnl: [],
    worst3TradesPnl: [],
    filterSimulations: {
      totalPnl: 0,
      totalTrades: 0,
      byHour: [],
      byDay: [],
      removeAllSL: { tradesRemoved: 0, pnlDelta: 0, pnlAfter: 0, tradesAfter: 0 },
    },
    walkForward: null,
    rollingWalkForward: null,
    bySession: null,
    byRegime: null,
  };
}

function computeDirectionStats(trades: CompletedTrade[]): Record<string, DirectionStats> {
  const buckets: Record<string, { count: number; pnl: number; wins: number; grossWin: number; grossLoss: number }> = {};

  for (const t of trades) {
    const dir = t.direction === "long" ? "Long" : "Short";
    if (!buckets[dir]) buckets[dir] = { count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0 };
    buckets[dir].count++;
    buckets[dir].pnl += t.pnl;
    if (t.pnl > 0) {
      buckets[dir].wins++;
      buckets[dir].grossWin += t.pnl;
    } else {
      buckets[dir].grossLoss += Math.abs(t.pnl);
    }
  }

  const result: Record<string, DirectionStats> = {};
  for (const [dir, b] of Object.entries(buckets)) {
    result[dir] = {
      count: b.count,
      pnl: b.pnl,
      winRate: b.count > 0 ? (b.wins / b.count) * 100 : 0,
      profitFactor: b.grossLoss > 0 ? b.grossWin / b.grossLoss : b.grossWin > 0 ? Infinity : 0,
      avgTrade: b.count > 0 ? b.pnl / b.count : 0,
    };
  }
  return result;
}

function computeExitTypeStats(trades: CompletedTrade[]): ExitTypeStats[] {
  const buckets: Record<string, { count: number; pnl: number; wins: number }> = {};

  for (const t of trades) {
    const key = t.exitType;
    if (!buckets[key]) buckets[key] = { count: 0, pnl: 0, wins: 0 };
    buckets[key].count++;
    buckets[key].pnl += t.pnl;
    if (t.pnl > 0) buckets[key].wins++;
  }

  return Object.entries(buckets).map(([signal, b]) => ({
    signal,
    count: b.count,
    pnl: b.pnl,
    winRate: b.count > 0 ? (b.wins / b.count) * 100 : 0,
  }));
}

function computeAvgBars(trades: CompletedTrade[]): { avgBarsWinners: number | null; avgBarsLosers: number | null } {
  const winners = trades.filter((t) => t.pnl > 0);
  const losers = trades.filter((t) => t.pnl <= 0);

  const avgBarsWinners = winners.length > 0
    ? winners.reduce((s, t) => s + t.barsHeld, 0) / winners.length
    : null;

  const avgBarsLosers = losers.length > 0
    ? losers.reduce((s, t) => s + t.barsHeld, 0) / losers.length
    : null;

  return { avgBarsWinners, avgBarsLosers };
}

function computeDayStats(trades: CompletedTrade[]): Record<string, DayStats> {
  const buckets: Record<string, { count: number; pnl: number }> = {};

  for (const t of trades) {
    const day = DAY_NAMES[new Date(t.entryTimestamp).getUTCDay()];
    if (!buckets[day]) buckets[day] = { count: 0, pnl: 0 };
    buckets[day].count++;
    buckets[day].pnl += t.pnl;
  }

  const result: Record<string, DayStats> = {};
  for (const [day, b] of Object.entries(buckets)) {
    result[day] = { count: b.count, pnl: b.pnl };
  }
  return result;
}

function computeHourStats(trades: CompletedTrade[]): HourStats[] {
  const buckets: Map<number, { count: number; pnl: number }> = new Map();

  for (const t of trades) {
    const hour = new Date(t.entryTimestamp).getUTCHours();
    const existing = buckets.get(hour) ?? { count: 0, pnl: 0 };
    existing.count++;
    existing.pnl += t.pnl;
    buckets.set(hour, existing);
  }

  return Array.from(buckets.entries()).map(([hour, b]) => ({
    hour,
    count: b.count,
    pnl: b.pnl,
  }));
}

function rankHours(hourStats: HourStats[]): { bestHoursUTC: HourStats[]; worstHoursUTC: HourStats[] } {
  const sorted = [...hourStats].sort((a, b) => b.pnl - a.pnl);
  return {
    bestHoursUTC: sorted.slice(0, 3),
    worstHoursUTC: sorted.slice(-3).reverse(),
  };
}

function extremeTrades(trades: CompletedTrade[]): { best3TradesPnl: number[]; worst3TradesPnl: number[] } {
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  return {
    best3TradesPnl: sorted.slice(0, 3).map((t) => t.pnl),
    worst3TradesPnl: sorted.slice(-3).reverse().map((t) => t.pnl),
  };
}

function computeSessionStats(trades: CompletedTrade[]): Record<SessionName, SessionStats> | null {
  if (trades.length === 0) return null;

  interface Bucket {
    count: number;
    pnl: number;
    wins: number;
    grossWin: number;
    grossLoss: number;
    sumEdgeBps: number;
    sumCostBps: number;
  }

  const empty = (): Bucket => ({ count: 0, pnl: 0, wins: 0, grossWin: 0, grossLoss: 0, sumEdgeBps: 0, sumCostBps: 0 });

  const buckets: Record<SessionName, Bucket> = {
    Asia: empty(),
    London: empty(),
    NY: empty(),
    "Off-peak": empty(),
  };

  for (const t of trades) {
    const session = getSessionForTimestamp(t.entryTimestamp);
    const b = buckets[session];
    b.count++;
    b.pnl += t.pnl;
    if (t.pnl > 0) {
      b.wins++;
      b.grossWin += t.pnl;
    } else {
      b.grossLoss += Math.abs(t.pnl);
    }

    const notional = t.entryPrice * t.size;
    if (notional > 0) {
      b.sumEdgeBps += (t.pnl / notional) * 10_000;
      b.sumCostBps += ((t.commission + t.slippageCost + (t.fundingCost ?? 0)) / notional) * 10_000;
    }
  }

  const result: Record<string, SessionStats> = {};
  for (const [session, b] of Object.entries(buckets)) {
    result[session] = {
      count: b.count,
      pnl: b.pnl,
      winRate: b.count > 0 ? (b.wins / b.count) * 100 : 0,
      profitFactor: b.grossLoss > 0 ? b.grossWin / b.grossLoss : b.grossWin > 0 ? Infinity : 0,
      edgeBpsNet: b.count > 0 ? b.sumEdgeBps / b.count : 0,
      avgCostBps: b.count > 0 ? b.sumCostBps / b.count : 0,
    };
  }
  return result as Record<SessionName, SessionStats>;
}
