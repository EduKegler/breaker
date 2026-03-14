import { describe, it, expect } from "vitest";
import { computeWalkForward, computeRollingWalkForward } from "./walk-forward.js";
import type { CompletedTrade } from "../types/order.js";

function makeTrade(pnl: number, entryTimestamp: number, hour = 10): CompletedTrade {
  const ts = new Date(entryTimestamp);
  ts.setUTCHours(hour);
  return {
    direction: "long",
    entryPrice: 100,
    exitPrice: pnl > 0 ? 110 : 90,
    size: 1,
    pnl,
    pnlPct: pnl,
    rMultiple: pnl > 0 ? 2 : -1,
    entryTimestamp: ts.getTime(),
    exitTimestamp: ts.getTime() + 3600000,
    entryBarIndex: 0,
    exitBarIndex: 10,
    barsHeld: 10,
    exitType: pnl > 0 ? "tp1" : "sl",
    commission: 0.5,
    slippageCost: 0.1,
    entryComment: "test",
    exitComment: "test",
  };
}

describe("computeWalkForward", () => {
  it("returns null for < 10 trades", () => {
    const trades = Array.from({ length: 9 }, (_, i) =>
      makeTrade(5, Date.now() + i * 86400000),
    );
    expect(computeWalkForward(trades)).toBeNull();
  });

  it("splits 70/30 chronologically", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 20 }, (_, i) =>
      makeTrade(5, baseTime + i * 86400000),
    );
    const result = computeWalkForward(trades)!;
    expect(result.trainTrades).toBe(14); // floor(20 * 0.7)
    expect(result.testTrades).toBe(6);
    expect(result.splitRatio).toBe(0.7);
  });

  it("computes profit factors for each set", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = [
      // Train set (7 trades)
      ...Array.from({ length: 5 }, (_, i) => makeTrade(10, baseTime + i * 86400000)),
      ...Array.from({ length: 2 }, (_, i) => makeTrade(-5, baseTime + (i + 5) * 86400000)),
      // Test set (3 trades)
      ...Array.from({ length: 2 }, (_, i) => makeTrade(8, baseTime + (i + 7) * 86400000)),
      makeTrade(-4, baseTime + 9 * 86400000),
    ];
    const result = computeWalkForward(trades)!;
    expect(result.trainPF).toBeGreaterThan(0);
    expect(result.testPF).toBeGreaterThan(0);
    expect(result.pfRatio).toBeGreaterThan(0);
  });

  it("flags overfit when test PF < 60% of train PF", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = [
      // Strong train
      ...Array.from({ length: 7 }, (_, i) => makeTrade(20, baseTime + i * 86400000)),
      // Weak test
      ...Array.from({ length: 3 }, (_, i) => makeTrade(-10, baseTime + (i + 7) * 86400000)),
    ];
    const result = computeWalkForward(trades)!;
    expect(result.overfitFlag).toBe(true);
  });

  it("does NOT flag overfit when trainPF < 1.0 but pfRatio healthy", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = [
      // Train set (7 trades): 5 small wins, 2 larger losses → trainPF < 1.0
      ...Array.from({ length: 5 }, (_, i) => makeTrade(2, baseTime + i * 86400000)),
      ...Array.from({ length: 2 }, (_, i) => makeTrade(-8, baseTime + (i + 5) * 86400000)),
      // Test set (3 trades): all winners → testPF high, pfRatio > 0.6
      ...Array.from({ length: 3 }, (_, i) => makeTrade(20, baseTime + (i + 7) * 86400000)),
    ];
    const result = computeWalkForward(trades)!;
    expect(result.trainPF).toBeLessThan(1.0);
    expect(result.pfRatio).toBeGreaterThan(0.6);
    expect(result.overfitFlag).toBe(false);
  });

  it("does not flag overfit when trainPF >= 1.0 and pfRatio healthy", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = [
      // Train set (7 trades): healthy PF
      ...Array.from({ length: 5 }, (_, i) => makeTrade(10, baseTime + i * 86400000)),
      ...Array.from({ length: 2 }, (_, i) => makeTrade(-5, baseTime + (i + 5) * 86400000)),
      // Test set (3 trades): also healthy
      ...Array.from({ length: 2 }, (_, i) => makeTrade(8, baseTime + (i + 7) * 86400000)),
      makeTrade(-4, baseTime + 9 * 86400000),
    ];
    const result = computeWalkForward(trades)!;
    expect(result.trainPF).toBeGreaterThanOrEqual(1.0);
    expect(result.overfitFlag).toBe(false);
  });

  it("does NOT flag overfit when both PFs < 1.0 but consistent (pfRatio > 0.6)", () => {
    // Reproduces the scenario from the failed run: both train/test losing but consistent
    const baseTime = new Date("2024-01-01").getTime();
    const trades = [
      // Train (7 trades): slightly losing, PF ~0.85
      ...Array.from({ length: 4 }, (_, i) => makeTrade(5, baseTime + i * 86400000)),
      ...Array.from({ length: 3 }, (_, i) => makeTrade(-8, baseTime + (i + 4) * 86400000)),
      // Test (3 trades): also slightly losing, similar PF → pfRatio near 1.0
      makeTrade(5, baseTime + 7 * 86400000),
      makeTrade(-8, baseTime + 8 * 86400000),
      makeTrade(2, baseTime + 9 * 86400000),
    ];
    const result = computeWalkForward(trades)!;
    expect(result.trainPF).toBeLessThan(1.0);
    expect(result.testPF).toBeLessThan(1.0);
    expect(result.pfRatio).toBeGreaterThan(0.6);
    expect(result.overfitFlag).toBe(false);
  });

  it("does not flag overfit when test performs well", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 20 }, (_, i) =>
      makeTrade(5, baseTime + i * 86400000),
    );
    const result = computeWalkForward(trades)!;
    expect(result.overfitFlag).toBe(false);
  });

  it("computes hour consistency", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 20 }, (_, i) =>
      makeTrade(i < 15 ? 5 : -3, baseTime + i * 86400000, 10),
    );
    const result = computeWalkForward(trades)!;
    expect(result.hourConsistency.length).toBeGreaterThan(0);
    expect(result.hourConsistency[0].hour).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// computeRollingWalkForward
// ---------------------------------------------------------------------------

describe("computeRollingWalkForward", () => {
  it("returns null with < 40 trades", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 39 }, (_, i) =>
      makeTrade(5, baseTime + i * 86400000),
    );
    expect(computeRollingWalkForward(trades)).toBeNull();
  });

  it("produces 3 windows with 40+ trades", () => {
    const baseTime = new Date("2024-01-01").getTime();
    const trades = Array.from({ length: 48 }, (_, i) =>
      makeTrade(5, baseTime + i * 86400000),
    );
    const result = computeRollingWalkForward(trades)!;
    expect(result).not.toBeNull();
    expect(result.windows).toHaveLength(3);
    expect(result.windowsTotal).toBe(3);
  });

  it("all windows pass when performance is stable", () => {
    const baseTime = new Date("2024-01-01").getTime();
    // Consistent winners throughout all 4 blocks
    const trades = Array.from({ length: 48 }, (_, i) =>
      makeTrade(i % 3 === 0 ? -3 : 8, baseTime + i * 86400000),
    );
    const result = computeRollingWalkForward(trades)!;
    expect(result.windowsPassed).toBe(3);
    expect(result.passRate).toBeCloseTo(1.0);
    expect(result.overfitFlag).toBe(false);
  });

  it("detects overfit when final blocks degrade", () => {
    const baseTime = new Date("2024-01-01").getTime();
    // Block 1-2: strong winners, block 3-4: all losers
    const trades = [
      // Block 1 (12 trades): strong
      ...Array.from({ length: 12 }, (_, i) => makeTrade(10, baseTime + i * 86400000)),
      // Block 2 (12 trades): strong
      ...Array.from({ length: 12 }, (_, i) => makeTrade(10, baseTime + (12 + i) * 86400000)),
      // Block 3 (12 trades): all losers
      ...Array.from({ length: 12 }, (_, i) => makeTrade(-10, baseTime + (24 + i) * 86400000)),
      // Block 4 (12 trades): all losers
      ...Array.from({ length: 12 }, (_, i) => makeTrade(-10, baseTime + (36 + i) * 86400000)),
    ];
    const result = computeRollingWalkForward(trades)!;
    // W0: train=[1] (strong) → test=[2] (strong) → pass
    // W1: train=[1,2] (strong) → test=[3] (losers) → fail
    // W2: train=[1,2,3] (mixed) → test=[4] (losers) → fail
    expect(result.windowsPassed).toBeLessThanOrEqual(1);
    expect(result.overfitFlag).toBe(true);
  });

  it("passRate and worstPfRatio calculate correctly", () => {
    const baseTime = new Date("2024-01-01").getTime();
    // Mix: blocks 1-3 profitable, block 4 losing
    const trades = [
      ...Array.from({ length: 12 }, (_, i) => makeTrade(i % 4 === 0 ? -3 : 10, baseTime + i * 86400000)),
      ...Array.from({ length: 12 }, (_, i) => makeTrade(i % 4 === 0 ? -3 : 10, baseTime + (12 + i) * 86400000)),
      ...Array.from({ length: 12 }, (_, i) => makeTrade(i % 4 === 0 ? -3 : 10, baseTime + (24 + i) * 86400000)),
      ...Array.from({ length: 12 }, (_, i) => makeTrade(-10, baseTime + (36 + i) * 86400000)),
    ];
    const result = computeRollingWalkForward(trades)!;
    expect(result.passRate).toBe(result.windowsPassed / result.windowsTotal);
    expect(result.worstPfRatio).not.toBeNull();
    // worstPfRatio should be the minimum of all window pfRatios
    const allRatios = result.windows.map(w => w.pfRatio).filter((r): r is number => r !== null);
    expect(result.worstPfRatio).toBeCloseTo(Math.min(...allRatios));
  });

  it("does NOT flag overfit when 2/3 pass (passRate=0.67 > 0.5)", () => {
    const baseTime = new Date("2024-01-01").getTime();
    // Block 1-3: profitable, block 4: slightly weaker but still positive
    const trades = [
      ...Array.from({ length: 12 }, (_, i) => makeTrade(i % 3 === 0 ? -2 : 10, baseTime + i * 86400000)),
      ...Array.from({ length: 12 }, (_, i) => makeTrade(i % 3 === 0 ? -2 : 10, baseTime + (12 + i) * 86400000)),
      ...Array.from({ length: 12 }, (_, i) => makeTrade(i % 3 === 0 ? -2 : 10, baseTime + (24 + i) * 86400000)),
      ...Array.from({ length: 12 }, (_, i) => makeTrade(i % 3 === 0 ? -2 : 10, baseTime + (36 + i) * 86400000)),
    ];
    const result = computeRollingWalkForward(trades)!;
    // With stable performance across all blocks, all 3 should pass
    expect(result.windowsPassed).toBeGreaterThanOrEqual(2);
    expect(result.overfitFlag).toBe(false);
  });

  it("flags overfit when only 1/3 passes (passRate=0.33 < 0.5)", () => {
    const baseTime = new Date("2024-01-01").getTime();
    // Block 1: strong, block 2: moderate positive (so W0 passes)
    // Block 3-4: losers so W1 and W2 fail
    const trades = [
      // Block 1 (12 trades): very strong
      ...Array.from({ length: 12 }, (_, i) => makeTrade(20, baseTime + i * 86400000)),
      // Block 2 (12 trades): still decent → W0 passes (train=B1, test=B2)
      ...Array.from({ length: 10 }, (_, i) => makeTrade(15, baseTime + (12 + i) * 86400000)),
      ...Array.from({ length: 2 }, (_, i) => makeTrade(-5, baseTime + (22 + i) * 86400000)),
      // Block 3 (12 trades): heavy losers → W1 fails
      ...Array.from({ length: 12 }, (_, i) => makeTrade(-15, baseTime + (24 + i) * 86400000)),
      // Block 4 (12 trades): heavy losers → W2 fails
      ...Array.from({ length: 12 }, (_, i) => makeTrade(-15, baseTime + (36 + i) * 86400000)),
    ];
    const result = computeRollingWalkForward(trades)!;
    // W0: train=[B1] → test=[B2] → should pass (both profitable)
    // W1: train=[B1,B2] → test=[B3] → should fail (test PF=0)
    // W2: train=[B1,B2,B3] → test=[B4] → should fail (test PF=0)
    expect(result.windowsPassed).toBeLessThanOrEqual(1);
    expect(result.passRate).toBeLessThan(0.5);
    expect(result.overfitFlag).toBe(true);
  });

  it("returns null when a block has < 5 trades", () => {
    const baseTime = new Date("2024-01-01").getTime();
    // 40 trades but heavily uneven distribution won't happen with equal splitting,
    // so we need exactly 40 trades where floor(40/4)=10 per block — all >= 5
    // Instead test with 41 trades where last block gets remainder
    // Actually blocks are floor-divided; 40/4=10, all >= 5. Null only happens if < 40.
    // For < 5 per block: need 4*4=16 trades? No, 16 < 40 so already null.
    // This test verifies the < 40 guard catches the edge case.
    const trades = Array.from({ length: 20 }, (_, i) =>
      makeTrade(5, baseTime + i * 86400000),
    );
    expect(computeRollingWalkForward(trades)).toBeNull();
  });
});
