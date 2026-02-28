import { describe, it, expect } from "vitest";
import { PositionBook } from "./position-book.js";

const basePos = {
  coin: "BTC",
  direction: "long" as const,
  entryPrice: 95000,
  size: 0.01,
  stopLoss: 94000,
  takeProfits: [{ price: 97000, pctOfPosition: 0.5 }],
  liquidationPx: null as number | null,
  trailingStopLoss: null as number | null,
  openedAt: "2024-01-01T00:00:00Z",
  signalId: 1,
};

describe("PositionBook", () => {
  it("opens and retrieves a position", () => {
    const book = new PositionBook();
    book.open(basePos);

    const pos = book.get("BTC");
    expect(pos).not.toBeNull();
    expect(pos!.direction).toBe("long");
    expect(pos!.entryPrice).toBe(95000);
    expect(pos!.currentPrice).toBe(95000);
    expect(pos!.unrealizedPnl).toBe(0);
  });

  it("throws when opening duplicate position", () => {
    const book = new PositionBook();
    book.open(basePos);
    expect(() => book.open(basePos)).toThrow("already open");
  });

  it("closes position and returns it", () => {
    const book = new PositionBook();
    book.open(basePos);

    const closed = book.close("BTC");
    expect(closed).not.toBeNull();
    expect(closed!.coin).toBe("BTC");
    expect(book.count()).toBe(0);
  });

  it("returns null when closing non-existent position", () => {
    const book = new PositionBook();
    expect(book.close("ETH")).toBeNull();
  });

  it("updates price and unrealized PnL for long", () => {
    const book = new PositionBook();
    book.open(basePos);
    book.updatePrice("BTC", 96000);

    const pos = book.get("BTC")!;
    expect(pos.currentPrice).toBe(96000);
    expect(pos.unrealizedPnl).toBe(10); // (96000 - 95000) * 0.01
  });

  it("updates price and unrealized PnL for short", () => {
    const book = new PositionBook();
    book.open({ ...basePos, direction: "short" });
    book.updatePrice("BTC", 94000);

    const pos = book.get("BTC")!;
    expect(pos.unrealizedPnl).toBe(10); // (95000 - 94000) * 0.01
  });

  it("reports isFlat correctly", () => {
    const book = new PositionBook();
    expect(book.isFlat("BTC")).toBe(true);

    book.open(basePos);
    expect(book.isFlat("BTC")).toBe(false);
  });

  it("getAll returns all positions", () => {
    const book = new PositionBook();
    book.open(basePos);
    book.open({ ...basePos, coin: "ETH", entryPrice: 3500 });

    expect(book.getAll()).toHaveLength(2);
    expect(book.count()).toBe(2);
  });

  it("ignores updatePrice for non-existent coin", () => {
    const book = new PositionBook();
    book.updatePrice("BTC", 100000); // should not throw
  });

  it("ignores updatePrice with NaN", () => {
    const book = new PositionBook();
    book.open(basePos);
    book.updatePrice("BTC", 96000); // valid update first
    book.updatePrice("BTC", NaN);

    const pos = book.get("BTC")!;
    expect(pos.currentPrice).toBe(96000); // unchanged
    expect(pos.unrealizedPnl).toBe(10);
  });

  it("ignores updatePrice with Infinity", () => {
    const book = new PositionBook();
    book.open(basePos);
    book.updatePrice("BTC", 96000);
    book.updatePrice("BTC", Infinity);

    const pos = book.get("BTC")!;
    expect(pos.currentPrice).toBe(96000); // unchanged
  });

  it("ignores updatePrice with -Infinity", () => {
    const book = new PositionBook();
    book.open(basePos);
    book.updatePrice("BTC", 96000);
    book.updatePrice("BTC", -Infinity);

    const pos = book.get("BTC")!;
    expect(pos.currentPrice).toBe(96000); // unchanged
  });

  it("ignores updatePrice with zero", () => {
    const book = new PositionBook();
    book.open(basePos);
    book.updatePrice("BTC", 96000);
    book.updatePrice("BTC", 0);

    const pos = book.get("BTC")!;
    expect(pos.currentPrice).toBe(96000); // unchanged
  });

  it("ignores updatePrice with negative price", () => {
    const book = new PositionBook();
    book.open(basePos);
    book.updatePrice("BTC", 96000);
    book.updatePrice("BTC", -100);

    const pos = book.get("BTC")!;
    expect(pos.currentPrice).toBe(96000); // unchanged
  });

  it("updates liquidation price", () => {
    const book = new PositionBook();
    book.open(basePos);

    expect(book.get("BTC")!.liquidationPx).toBeNull();

    book.updateLiquidationPx("BTC", 85000);
    expect(book.get("BTC")!.liquidationPx).toBe(85000);

    book.updateLiquidationPx("BTC", null);
    expect(book.get("BTC")!.liquidationPx).toBeNull();
  });

  it("ignores updateLiquidationPx for non-existent coin", () => {
    const book = new PositionBook();
    book.updateLiquidationPx("ETH", 2000); // should not throw
  });

  it("updates stop loss", () => {
    const book = new PositionBook();
    book.open(basePos);

    book.updateStopLoss("BTC", 93000);
    expect(book.get("BTC")!.stopLoss).toBe(93000);
  });

  it("ignores updateStopLoss for non-existent coin", () => {
    const book = new PositionBook();
    book.updateStopLoss("ETH", 3000); // should not throw
  });

  it("updates take profits", () => {
    const book = new PositionBook();
    book.open(basePos);

    const newTps = [
      { price: 97000, pctOfPosition: 0.5 },
      { price: 99000, pctOfPosition: 0.5 },
    ];
    book.updateTakeProfits("BTC", newTps);
    expect(book.get("BTC")!.takeProfits).toEqual(newTps);
  });

  it("ignores updateTakeProfits for non-existent coin", () => {
    const book = new PositionBook();
    book.updateTakeProfits("ETH", [{ price: 5000, pctOfPosition: 1 }]); // should not throw
  });

  it("updates trailing stop loss", () => {
    const book = new PositionBook();
    book.open(basePos);

    expect(book.get("BTC")!.trailingStopLoss).toBeNull();

    book.updateTrailingStopLoss("BTC", 94500);
    expect(book.get("BTC")!.trailingStopLoss).toBe(94500);
  });

  it("clears trailing stop loss with null", () => {
    const book = new PositionBook();
    book.open(basePos);

    book.updateTrailingStopLoss("BTC", 94500);
    book.updateTrailingStopLoss("BTC", null);
    expect(book.get("BTC")!.trailingStopLoss).toBeNull();
  });

  it("ignores updateTrailingStopLoss for non-existent coin", () => {
    const book = new PositionBook();
    book.updateTrailingStopLoss("ETH", 3000); // should not throw
  });
});
