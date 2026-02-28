import { describe, it, expect } from "vitest";
import { analyzeTradeList } from "./trade-analysis.js";
import { getSessionForHour } from "./get-session-for-hour.js";
import type { CompletedTrade } from "../types/order.js";

function makeTrade(overrides: Partial<CompletedTrade> = {}): CompletedTrade {
  return {
    direction: "long",
    entryPrice: 100,
    exitPrice: 110,
    size: 1,
    pnl: 10,
    pnlPct: 10,
    rMultiple: 2,
    entryTimestamp: new Date("2024-06-15T10:00:00Z").getTime(), // Sat 10 UTC = London
    exitTimestamp: new Date("2024-06-15T12:00:00Z").getTime(),
    entryBarIndex: 0,
    exitBarIndex: 8,
    barsHeld: 8,
    exitType: "tp1",
    commission: 0.5,
    slippageCost: 0.1,
    entryComment: "entry",
    exitComment: "TP1",
    ...overrides,
  };
}

describe("getSessionForHour", () => {
  it("classifies Asia hours", () => {
    for (let h = 0; h < 8; h++) {
      expect(getSessionForHour(h)).toBe("Asia");
    }
  });

  it("classifies London hours", () => {
    for (let h = 8; h < 13; h++) {
      expect(getSessionForHour(h)).toBe("London");
    }
  });

  it("classifies NY hours", () => {
    for (let h = 13; h < 21; h++) {
      expect(getSessionForHour(h)).toBe("NY");
    }
  });

  it("classifies Off-peak hours", () => {
    for (let h = 21; h < 24; h++) {
      expect(getSessionForHour(h)).toBe("Off-peak");
    }
  });
});

describe("analyzeTradeList", () => {
  it("returns empty analysis for no trades", () => {
    const result = analyzeTradeList([]);
    expect(result.totalExitRows).toBe(0);
    expect(result.byDirection).toEqual({});
    expect(result.walkForward).toBeNull();
    expect(result.bySession).toBeNull();
  });

  it("computes direction stats", () => {
    const trades = [
      makeTrade({ direction: "long", pnl: 10 }),
      makeTrade({ direction: "long", pnl: -5 }),
      makeTrade({ direction: "short", pnl: 8 }),
    ];
    const result = analyzeTradeList(trades);

    expect(result.byDirection["Long"].count).toBe(2);
    expect(result.byDirection["Long"].pnl).toBe(5);
    expect(result.byDirection["Long"].winRate).toBe(50);
    expect(result.byDirection["Short"].count).toBe(1);
    expect(result.byDirection["Short"].pnl).toBe(8);
  });

  it("computes exit type stats", () => {
    const trades = [
      makeTrade({ exitType: "sl", pnl: -5 }),
      makeTrade({ exitType: "sl", pnl: -3 }),
      makeTrade({ exitType: "tp1", pnl: 10 }),
    ];
    const result = analyzeTradeList(trades);

    const slStats = result.byExitType.find((e) => e.signal === "sl")!;
    expect(slStats.count).toBe(2);
    expect(slStats.pnl).toBe(-8);
    expect(slStats.winRate).toBe(0);

    const tpStats = result.byExitType.find((e) => e.signal === "tp1")!;
    expect(tpStats.count).toBe(1);
    expect(tpStats.winRate).toBe(100);
  });

  it("computes average bars for winners and losers", () => {
    const trades = [
      makeTrade({ pnl: 10, barsHeld: 8 }),
      makeTrade({ pnl: 5, barsHeld: 12 }),
      makeTrade({ pnl: -3, barsHeld: 4 }),
    ];
    const result = analyzeTradeList(trades);
    expect(result.avgBarsWinners).toBe(10); // (8+12)/2
    expect(result.avgBarsLosers).toBe(4);
  });

  it("computes day-of-week stats", () => {
    // June 15, 2024 is a Saturday
    const trades = [
      makeTrade({ entryTimestamp: new Date("2024-06-15T10:00:00Z").getTime(), pnl: 10 }),
      makeTrade({ entryTimestamp: new Date("2024-06-17T10:00:00Z").getTime(), pnl: -5 }), // Mon
    ];
    const result = analyzeTradeList(trades);
    expect(result.byDayOfWeek["Sat"]).toBeDefined();
    expect(result.byDayOfWeek["Mon"]).toBeDefined();
    expect(result.byDayOfWeek["Sat"].pnl).toBe(10);
  });

  it("ranks best and worst hours", () => {
    const trades = [
      makeTrade({ entryTimestamp: new Date("2024-06-15T10:00:00Z").getTime(), pnl: 20 }),
      makeTrade({ entryTimestamp: new Date("2024-06-15T14:00:00Z").getTime(), pnl: -15 }),
      makeTrade({ entryTimestamp: new Date("2024-06-15T08:00:00Z").getTime(), pnl: 5 }),
    ];
    const result = analyzeTradeList(trades);
    expect(result.bestHoursUTC[0].hour).toBe(10);
    expect(result.worstHoursUTC[0].hour).toBe(14);
  });

  it("computes best and worst 3 trades", () => {
    const trades = [
      makeTrade({ pnl: 50 }),
      makeTrade({ pnl: 30 }),
      makeTrade({ pnl: 20 }),
      makeTrade({ pnl: -10 }),
      makeTrade({ pnl: -25 }),
      makeTrade({ pnl: -40 }),
    ];
    const result = analyzeTradeList(trades);
    expect(result.best3TradesPnl).toEqual([50, 30, 20]);
    expect(result.worst3TradesPnl).toEqual([-40, -25, -10]);
  });

  it("computes session stats", () => {
    const trades = [
      makeTrade({ entryTimestamp: new Date("2024-06-15T03:00:00Z").getTime(), pnl: 10 }), // Asia
      makeTrade({ entryTimestamp: new Date("2024-06-15T10:00:00Z").getTime(), pnl: 15 }), // London
      makeTrade({ entryTimestamp: new Date("2024-06-15T15:00:00Z").getTime(), pnl: -5 }), // NY
    ];
    const result = analyzeTradeList(trades);
    expect(result.bySession!["Asia"].count).toBe(1);
    expect(result.bySession!["Asia"].pnl).toBe(10);
    expect(result.bySession!["London"].count).toBe(1);
    expect(result.bySession!["NY"].count).toBe(1);
  });
});
