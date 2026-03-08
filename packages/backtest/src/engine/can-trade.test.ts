import { describe, it, expect } from "vitest";
import { canTrade, type CanTradeParams } from "./can-trade.js";

const ok: CanTradeParams = {
  barsSinceExit: 5,
  cooldownBars: 3,
  dailyPnl: 0,
  maxDailyLossUsd: 100,
  tradesToday: 0,
  maxTradesPerDay: 10,
  maxGlobalTradesDay: 10,
};

describe("canTrade", () => {
  it("returns true when all conditions met", () => {
    expect(canTrade(ok)).toBe(true);
  });

  it("returns false during cooldown", () => {
    expect(canTrade({ ...ok, barsSinceExit: 2 })).toBe(false);
  });

  it("returns false when daily loss exceeded", () => {
    expect(canTrade({ ...ok, dailyPnl: -200 })).toBe(false);
  });

  it("returns false when max trades reached", () => {
    expect(canTrade({ ...ok, tradesToday: 10 })).toBe(false);
  });

  it("returns true when dailyPnl equals -maxDailyLossUsd (strict >)", () => {
    expect(canTrade({ ...ok, dailyPnl: -100 })).toBe(false);
  });

  it("uses Math.min of maxTradesPerDay and maxGlobalTradesDay", () => {
    expect(canTrade({ ...ok, tradesToday: 5, maxTradesPerDay: 10, maxGlobalTradesDay: 5 })).toBe(false);
  });
});
