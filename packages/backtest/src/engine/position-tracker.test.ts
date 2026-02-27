import { describe, it, expect } from "vitest";
import { PositionTracker } from "./position-tracker.js";
import type { Fill } from "../types/order.js";

function makeFill(price: number, size: number, side: "buy" | "sell", tag = "entry"): Fill {
  return {
    orderId: "test",
    price,
    size,
    side,
    fee: 0.5,
    slippage: 0.1,
    timestamp: Date.now(),
    tag,
  };
}

describe("PositionTracker", () => {
  it("starts flat", () => {
    const pt = new PositionTracker();
    expect(pt.isFlat()).toBe(true);
    expect(pt.getPosition()).toBeNull();
    expect(pt.getCompletedTrades()).toEqual([]);
  });

  it("opens a long position", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 1, "buy"), 5);
    expect(pt.isFlat()).toBe(false);
    expect(pt.getPosition()!.direction).toBe("long");
    expect(pt.getPosition()!.entryPrice).toBe(100);
    expect(pt.getPosition()!.size).toBe(1);
  });

  it("throws when opening with existing position", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 1, "buy"), 5);
    expect(() => pt.openPosition("short", makeFill(100, 1, "sell"), 5)).toThrow();
  });

  it("updates unrealized PnL for long", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 2, "buy"), 5);
    pt.updateMtm(110);
    expect(pt.getPosition()!.unrealizedPnl).toBe(20);
  });

  it("updates unrealized PnL for short", () => {
    const pt = new PositionTracker();
    pt.openPosition("short", makeFill(100, 2, "sell"), 5);
    pt.updateMtm(90);
    expect(pt.getPosition()!.unrealizedPnl).toBe(20);
  });

  it("closes position and records trade", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 1, "buy"), 5);
    pt.setEntryBarIndex(10);

    const exitFill = makeFill(110, 1, "sell", "sl");
    const trade = pt.closePosition(exitFill, 20, "sl", "SL hit", "Breakout entry");

    expect(pt.isFlat()).toBe(true);
    expect(trade.direction).toBe("long");
    expect(trade.entryPrice).toBe(100);
    expect(trade.exitPrice).toBe(110);
    // PnL = (110-100)*1 = 10, minus commissions (0.5 entry + 0.5 exit = 1.0)
    expect(trade.pnl).toBeCloseTo(9, 5);
    expect(trade.barsHeld).toBe(10);
    expect(trade.exitType).toBe("sl");
    expect(trade.entryComment).toBe("Breakout entry");
    expect(trade.exitComment).toBe("SL hit");
  });

  it("computes correct R multiple", () => {
    const pt = new PositionTracker();
    // Stop distance = 5 (risk per unit = $5)
    pt.openPosition("long", makeFill(100, 2, "buy"), 5);
    pt.setEntryBarIndex(0);

    // Exit at 115 → PnL = (115-100)*2 = 30, minus fees (0.5+0.5=1) = 29
    // R = 29 / (5 * 2) = 2.9
    const trade = pt.closePosition(makeFill(115, 2, "sell", "tp"), 5, "tp1", "TP1", "entry");
    expect(trade.rMultiple).toBeCloseTo(2.9, 1);
  });

  it("handles short position PnL", () => {
    const pt = new PositionTracker();
    pt.openPosition("short", makeFill(100, 1, "sell"), 5);
    pt.setEntryBarIndex(0);

    const trade = pt.closePosition(makeFill(90, 1, "buy", "tp"), 5, "tp1", "TP1", "entry");
    // PnL = (100-90)*1 = 10, minus fees (1.0) = 9
    expect(trade.pnl).toBeCloseTo(9, 5);
  });

  it("partial close reduces position size", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 2, "buy"), 5);
    pt.setEntryBarIndex(0);

    const trade = pt.partialClose(makeFill(110, 1, "sell", "tp1"), 5, "tp1", "TP1", "entry");

    expect(pt.isFlat()).toBe(false);
    expect(pt.getPosition()!.size).toBe(1);
    expect(trade.size).toBe(1);
    // PnL on partial: (110-100)*1 = 10, minus proportional entry fee (0.25) + exit fee (0.5) = 9.25
    expect(trade.pnl).toBeCloseTo(9.25, 1);
  });

  it("partial close with full size closes position", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 1, "buy"), 5);
    pt.setEntryBarIndex(0);

    pt.partialClose(makeFill(110, 1, "sell", "tp1"), 5, "tp1", "TP1", "entry");
    expect(pt.isFlat()).toBe(true);
  });

  it("partialClose delegates to closePosition when fill.size > position.size", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 1, "buy"), 5);
    pt.setEntryBarIndex(0);

    // fill.size=2 > position.size=1 → should fully close
    const trade = pt.partialClose(makeFill(110, 2, "sell", "tp1"), 5, "tp1", "TP1", "entry");
    expect(pt.isFlat()).toBe(true);
    expect(trade.size).toBe(1); // closePosition uses position.size, not fill.size
    expect(trade.exitPrice).toBe(110);
  });

  it("partialClose returns rMultiple=0 when initialStopDistance is 0", () => {
    const pt = new PositionTracker();
    pt.openPosition("long", makeFill(100, 2, "buy"), 0); // stopDistance=0
    pt.setEntryBarIndex(0);

    const trade = pt.partialClose(makeFill(110, 1, "sell", "tp1"), 5, "tp1", "TP1", "entry");
    expect(trade.rMultiple).toBe(0);
    expect(trade.pnl).toBeGreaterThan(0); // PnL still positive
    expect(pt.isFlat()).toBe(false);
    expect(pt.getPosition()!.size).toBe(1);
  });

  it("throws when closing with no position", () => {
    const pt = new PositionTracker();
    expect(() =>
      pt.closePosition(makeFill(100, 1, "sell"), 0, "sl", "SL", "entry"),
    ).toThrow();
  });

  it("tracks all completed trades", () => {
    const pt = new PositionTracker();

    pt.openPosition("long", makeFill(100, 1, "buy"), 5);
    pt.setEntryBarIndex(0);
    pt.closePosition(makeFill(110, 1, "sell"), 5, "tp1", "TP1", "entry1");

    pt.openPosition("short", makeFill(110, 1, "sell"), 5);
    pt.setEntryBarIndex(5);
    pt.closePosition(makeFill(105, 1, "buy"), 10, "sl", "SL", "entry2");

    expect(pt.getCompletedTrades()).toHaveLength(2);
  });
});
