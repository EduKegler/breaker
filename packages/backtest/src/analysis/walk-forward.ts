import type { CompletedTrade } from "../types/order.js";
import type { WalkForward, HourConsistency } from "../types/metrics.js";

const TRAIN_RATIO = 0.7;

/**
 * Compute walk-forward validation: split trades 70/30 chronologically,
 * compare profit factors, flag potential overfitting.
 */
export function computeWalkForward(trades: CompletedTrade[]): WalkForward | null {
  if (trades.length < 10) return null;

  // Sort by entry timestamp
  const sorted = [...trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
  const splitIdx = Math.floor(sorted.length * TRAIN_RATIO);

  const trainTrades = sorted.slice(0, splitIdx);
  const testTrades = sorted.slice(splitIdx);

  if (trainTrades.length === 0 || testTrades.length === 0) return null;

  const trainPF = profitFactor(trainTrades);
  const testPF = profitFactor(testTrades);

  const pfRatio = trainPF !== null && testPF !== null && trainPF > 0
    ? testPF / trainPF
    : null;

  // Overfit flag: test PF < 50% of train PF, or test PF < 1.0
  const overfitFlag = pfRatio !== null
    ? pfRatio < 0.5 || (testPF !== null && testPF < 1.0)
    : false;

  const hourConsistency = computeHourConsistency(trainTrades, testTrades);

  return {
    trainTrades: trainTrades.length,
    testTrades: testTrades.length,
    splitRatio: TRAIN_RATIO,
    hourConsistency,
    trainPF,
    testPF,
    pfRatio,
    overfitFlag,
  };
}

function profitFactor(trades: CompletedTrade[]): number | null {
  if (trades.length === 0) return null;
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  if (grossLoss === 0) return grossWin > 0 ? Infinity : 0;
  return grossWin / grossLoss;
}

function computeHourConsistency(
  trainTrades: CompletedTrade[],
  testTrades: CompletedTrade[],
): HourConsistency[] {
  const hours = new Map<number, { trainPnl: number; trainCount: number; testPnl: number; testCount: number }>();

  for (const t of trainTrades) {
    const hour = new Date(t.entryTimestamp).getUTCHours();
    const existing = hours.get(hour) ?? { trainPnl: 0, trainCount: 0, testPnl: 0, testCount: 0 };
    existing.trainPnl += t.pnl;
    existing.trainCount++;
    hours.set(hour, existing);
  }

  for (const t of testTrades) {
    const hour = new Date(t.entryTimestamp).getUTCHours();
    const existing = hours.get(hour) ?? { trainPnl: 0, trainCount: 0, testPnl: 0, testCount: 0 };
    existing.testPnl += t.pnl;
    existing.testCount++;
    hours.set(hour, existing);
  }

  return Array.from(hours.entries())
    .sort(([a], [b]) => a - b)
    .map(([hour, data]) => ({
      hour,
      trainPnl: data.trainPnl,
      trainCount: data.trainCount,
      testPnl: data.testPnl,
      testCount: data.testCount,
      consistent:
        data.trainCount < 3 || data.testCount < 2
          ? null // Not enough data
          : (data.trainPnl > 0) === (data.testPnl > 0), // Same sign = consistent
    }));
}
