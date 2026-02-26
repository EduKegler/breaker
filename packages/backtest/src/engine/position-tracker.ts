import type { Position, CompletedTrade, Fill } from "../types/order.js";

export class PositionTracker {
  private position: Position | null = null;
  private completedTrades: CompletedTrade[] = [];
  private initialStopDistance: number = 0;

  getPosition(): Position | null {
    return this.position;
  }

  isFlat(): boolean {
    return this.position === null;
  }

  getCompletedTrades(): CompletedTrade[] {
    return this.completedTrades;
  }

  openPosition(
    direction: "long" | "short",
    fill: Fill,
    stopDistance: number,
  ): void {
    if (this.position) {
      throw new Error("Cannot open position: already in a position");
    }
    this.initialStopDistance = stopDistance;
    this.position = {
      direction,
      entryPrice: fill.price,
      size: fill.size,
      entryTimestamp: fill.timestamp,
      entryBarIndex: 0, // Will be set by engine
      unrealizedPnl: 0,
      fills: [fill],
    };
  }

  /**
   * Set the entry bar index (called by engine after open).
   */
  setEntryBarIndex(barIndex: number): void {
    if (this.position) {
      this.position.entryBarIndex = barIndex;
    }
  }

  /**
   * Update unrealized PnL based on current price.
   */
  updateMtm(currentPrice: number): void {
    if (!this.position) return;
    const { direction, entryPrice, size } = this.position;
    this.position.unrealizedPnl =
      direction === "long"
        ? (currentPrice - entryPrice) * size
        : (entryPrice - currentPrice) * size;
  }

  /**
   * Close entire position. Returns the completed trade.
   */
  closePosition(
    fill: Fill,
    exitBarIndex: number,
    exitType: string,
    exitComment: string,
    entryComment: string,
  ): CompletedTrade {
    if (!this.position) {
      throw new Error("Cannot close position: no position open");
    }

    const { direction, entryPrice, size, entryTimestamp, entryBarIndex, fills } =
      this.position;

    const pnl =
      direction === "long"
        ? (fill.price - entryPrice) * size
        : (entryPrice - fill.price) * size;

    const totalCommission =
      fills.reduce((s, f) => s + f.fee, 0) + fill.fee;
    const totalSlippage =
      fills.reduce((s, f) => s + f.slippage, 0) + fill.slippage;

    const netPnl = pnl - totalCommission;

    const rMultiple =
      this.initialStopDistance > 0
        ? netPnl / (this.initialStopDistance * size)
        : 0;

    const pnlPct = entryPrice > 0 ? (pnl / (entryPrice * size)) * 100 : 0;

    const trade: CompletedTrade = {
      direction,
      entryPrice,
      exitPrice: fill.price,
      size,
      pnl: netPnl,
      pnlPct,
      rMultiple,
      entryTimestamp,
      exitTimestamp: fill.timestamp,
      entryBarIndex,
      exitBarIndex,
      barsHeld: exitBarIndex - entryBarIndex,
      exitType,
      commission: totalCommission,
      slippageCost: totalSlippage,
      entryComment,
      exitComment,
    };

    this.completedTrades.push(trade);
    this.position = null;
    this.initialStopDistance = 0;

    return trade;
  }

  /**
   * Partially close a position. Reduces size and records a partial trade.
   */
  partialClose(
    fill: Fill,
    exitBarIndex: number,
    exitType: string,
    exitComment: string,
    entryComment: string,
  ): CompletedTrade {
    if (!this.position) {
      throw new Error("Cannot partial close: no position open");
    }

    if (fill.size >= this.position.size) {
      return this.closePosition(fill, exitBarIndex, exitType, exitComment, entryComment);
    }

    const { direction, entryPrice, entryTimestamp, entryBarIndex } = this.position;

    const pnl =
      direction === "long"
        ? (fill.price - entryPrice) * fill.size
        : (entryPrice - fill.price) * fill.size;

    const entryCommissionShare =
      (fill.size / this.position.size) *
      this.position.fills.reduce((s, f) => s + f.fee, 0);
    const totalCommission = entryCommissionShare + fill.fee;
    const totalSlippage =
      (fill.size / this.position.size) *
      this.position.fills.reduce((s, f) => s + f.slippage, 0) +
      fill.slippage;

    const netPnl = pnl - totalCommission;
    const rMultiple =
      this.initialStopDistance > 0
        ? netPnl / (this.initialStopDistance * fill.size)
        : 0;

    const pnlPct = entryPrice > 0 ? (pnl / (entryPrice * fill.size)) * 100 : 0;

    const trade: CompletedTrade = {
      direction,
      entryPrice,
      exitPrice: fill.price,
      size: fill.size,
      pnl: netPnl,
      pnlPct,
      rMultiple,
      entryTimestamp,
      exitTimestamp: fill.timestamp,
      entryBarIndex,
      exitBarIndex,
      barsHeld: exitBarIndex - entryBarIndex,
      exitType,
      commission: totalCommission,
      slippageCost: totalSlippage,
      entryComment,
      exitComment,
    };

    this.position.size -= fill.size;
    this.position.fills.push(fill);
    this.completedTrades.push(trade);

    return trade;
  }
}
