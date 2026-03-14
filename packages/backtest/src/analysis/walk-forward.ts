import type { CompletedTrade } from "../types/order.js";
import type { WalkForward, HourConsistency, RollingWalkForward, RollingWfWindow } from "../types/metrics.js";

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

  // Overfit flag: test PF < 60% of train PF (KB §10.1)
  // Only checks train/test divergence — absolute PF < 1.0 is enforced by scoring criteria,
  // not the WF guard. Conflating "bad strategy" with "overfitting" creates a Catch-22
  // where losing strategies can never improve (every iteration gets WF-rejected).
  const overfitFlag = pfRatio !== null ? pfRatio < 0.6 : false;

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

const ROLLING_MIN_TRADES = 40;
const ROLLING_NUM_BLOCKS = 4;
const ROLLING_MIN_TRADES_PER_BLOCK = 5;
const ROLLING_PF_RATIO_THRESHOLD = 0.6;

/**
 * Anchored rolling walk-forward: divide trades into 4 temporal blocks,
 * test 3 expanding windows (train=[1]→test=[2], [1,2]→[3], [1,2,3]→[4]).
 * Flags overfit if passRate < 0.5 (majority rule).
 */
export function computeRollingWalkForward(trades: CompletedTrade[]): RollingWalkForward | null {
  if (trades.length < ROLLING_MIN_TRADES) return null;

  const sorted = [...trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);

  // Split into 4 equal blocks
  const blockSize = Math.floor(sorted.length / ROLLING_NUM_BLOCKS);
  const blocks: CompletedTrade[][] = [];
  for (let i = 0; i < ROLLING_NUM_BLOCKS; i++) {
    const start = i * blockSize;
    const end = i === ROLLING_NUM_BLOCKS - 1 ? sorted.length : (i + 1) * blockSize;
    blocks.push(sorted.slice(start, end));
  }

  // Check minimum trades per block
  if (blocks.some(b => b.length < ROLLING_MIN_TRADES_PER_BLOCK)) return null;

  // 3 anchored folds: train accumulates, test is next block
  const windows: RollingWfWindow[] = [];
  for (let fold = 0; fold < ROLLING_NUM_BLOCKS - 1; fold++) {
    const trainTrades = blocks.slice(0, fold + 1).flat();
    const testTrades = blocks[fold + 1];

    const trainPF = profitFactor(trainTrades);
    const testPF = profitFactor(testTrades);

    const pfRatio = trainPF !== null && testPF !== null && trainPF > 0
      ? testPF / trainPF
      : null;

    const pass = pfRatio !== null ? pfRatio >= ROLLING_PF_RATIO_THRESHOLD : false;

    windows.push({
      windowIndex: fold,
      trainTrades: trainTrades.length,
      testTrades: testTrades.length,
      trainPF,
      testPF,
      pfRatio,
      pass,
    });
  }

  const windowsPassed = windows.filter(w => w.pass).length;
  const windowsTotal = windows.length;
  const passRate = windowsTotal > 0 ? windowsPassed / windowsTotal : 0;

  const pfRatios = windows.map(w => w.pfRatio).filter((r): r is number => r !== null);
  const worstPfRatio = pfRatios.length > 0 ? Math.min(...pfRatios) : null;

  return {
    windows,
    windowsPassed,
    windowsTotal,
    passRate,
    worstPfRatio,
    overfitFlag: passRate < 0.5,
  };
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
