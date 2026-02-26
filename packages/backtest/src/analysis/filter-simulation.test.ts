import { describe, it, expect } from "vitest";
import { computeFilterSimulations } from "./filter-simulation.js";
import type { CompletedTrade } from "../types/order.js";

function makeTrade(
  pnl: number,
  entryTimestamp: number,
  exitType = "tp1",
): CompletedTrade {
  return {
    direction: "long",
    entryPrice: 100,
    exitPrice: pnl > 0 ? 110 : 90,
    size: 1,
    pnl,
    pnlPct: pnl,
    rMultiple: pnl > 0 ? 2 : -1,
    entryTimestamp,
    exitTimestamp: entryTimestamp + 3600000,
    entryBarIndex: 0,
    exitBarIndex: 10,
    barsHeld: 10,
    exitType,
    commission: 0.5,
    slippageCost: 0.1,
    entryComment: "test",
    exitComment: "test",
  };
}

describe("computeFilterSimulations", () => {
  it("returns zeros for empty trades", () => {
    const result = computeFilterSimulations([]);
    expect(result.totalPnl).toBe(0);
    expect(result.totalTrades).toBe(0);
    expect(result.byHour).toEqual([]);
    expect(result.byDay).toEqual([]);
  });

  it("simulates removing by hour", () => {
    const trades = [
      makeTrade(10, new Date("2024-06-15T10:00:00Z").getTime()), // hour 10
      makeTrade(-5, new Date("2024-06-15T10:30:00Z").getTime()), // hour 10
      makeTrade(8, new Date("2024-06-15T14:00:00Z").getTime()),  // hour 14
    ];
    const result = computeFilterSimulations(trades);

    expect(result.totalPnl).toBe(13);
    expect(result.totalTrades).toBe(3);

    const hour10 = result.byHour.find((h) => h.hour === 10)!;
    expect(hour10.tradesRemoved).toBe(2);
    expect(hour10.pnlDelta).toBe(-5); // removing +5 net from hour 10
    expect(hour10.pnlAfter).toBe(8); // 13 - 5 = 8
    expect(hour10.tradesAfter).toBe(1);

    const hour14 = result.byHour.find((h) => h.hour === 14)!;
    expect(hour14.tradesRemoved).toBe(1);
    expect(hour14.pnlAfter).toBe(5); // 13 - 8 = 5
  });

  it("simulates removing by day", () => {
    const trades = [
      makeTrade(10, new Date("2024-06-15T10:00:00Z").getTime()), // Sat
      makeTrade(8, new Date("2024-06-17T10:00:00Z").getTime()),  // Mon
    ];
    const result = computeFilterSimulations(trades);

    const satSim = result.byDay.find((d) => d.day === "Sat")!;
    expect(satSim.tradesRemoved).toBe(1);
    expect(satSim.pnlAfter).toBe(8);

    const monSim = result.byDay.find((d) => d.day === "Mon")!;
    expect(monSim.tradesRemoved).toBe(1);
    expect(monSim.pnlAfter).toBe(10);
  });

  it("simulates removing all SL exits", () => {
    const trades = [
      makeTrade(-5, Date.now(), "sl"),
      makeTrade(-3, Date.now(), "sl"),
      makeTrade(10, Date.now(), "tp1"),
      makeTrade(8, Date.now(), "signal"),
    ];
    const result = computeFilterSimulations(trades);

    expect(result.removeAllSL.tradesRemoved).toBe(2);
    expect(result.removeAllSL.pnlDelta).toBe(8); // removing -8 net SL trades → +8
    expect(result.removeAllSL.pnlAfter).toBe(18); // 10 + 8 = 18
    expect(result.removeAllSL.tradesAfter).toBe(2);
  });
});
