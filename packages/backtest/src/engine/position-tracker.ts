import type { Position, CompletedTrade, Fill } from "../types/order.js";

interface CostResult {
  pnl: number;
  netPnl: number;
  commission: number;
  slippageCost: number;
  rMultiple: number;
  pnlPct: number;
}

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
   * Compute PnL, commission, slippage, netPnl, rMultiple, and pnlPct
   * for closing `exitSize` units at `exitFill` price.
   */
  private calculateCosts(
    exitFill: Fill,
    exitSize: number,
    fundingCost: number,
  ): CostResult {
    const { direction, entryPrice, fills } = this.position!;

    const pnl =
      direction === "long"
        ? (exitFill.price - entryPrice) * exitSize
        : (entryPrice - exitFill.price) * exitSize;

    const entryFills = fills.filter(f => f.tag === "entry");
    const originalSize = entryFills.reduce((s, f) => s + f.size, 0);
    const entryFees = entryFills.reduce((s, f) => s + f.fee, 0);
    const commission = (exitSize / originalSize) * entryFees + exitFill.fee;
    const entrySlip = entryFills.reduce((s, f) => s + f.slippage, 0);
    const slippageCost = (exitSize / originalSize) * entrySlip + exitFill.slippage;

    const netPnl = pnl - commission - fundingCost;

    const rMultiple =
      this.initialStopDistance > 0
        ? netPnl / (this.initialStopDistance * exitSize)
        : 0;

    const pnlPct = entryPrice > 0 ? (pnl / (entryPrice * exitSize)) * 100 : 0;

    return { pnl, netPnl, commission, slippageCost, rMultiple, pnlPct };
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
    fundingCost: number = 0,
  ): CompletedTrade {
    if (!this.position) {
      throw new Error("Cannot close position: no position open");
    }

    const { direction, entryPrice, size, entryTimestamp, entryBarIndex } =
      this.position;

    const costs = this.calculateCosts(fill, size, fundingCost);

    const trade: CompletedTrade = {
      direction,
      entryPrice,
      exitPrice: fill.price,
      size,
      pnl: costs.netPnl,
      pnlPct: costs.pnlPct,
      rMultiple: costs.rMultiple,
      entryTimestamp,
      exitTimestamp: fill.timestamp,
      entryBarIndex,
      exitBarIndex,
      barsHeld: exitBarIndex - entryBarIndex,
      exitType,
      commission: costs.commission,
      slippageCost: costs.slippageCost,
      fundingCost,
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
    fundingCost: number = 0,
  ): CompletedTrade {
    if (!this.position) {
      throw new Error("Cannot partial close: no position open");
    }

    if (fill.size >= this.position.size) {
      return this.closePosition(fill, exitBarIndex, exitType, exitComment, entryComment, fundingCost);
    }

    const { direction, entryPrice, entryTimestamp, entryBarIndex } = this.position;

    const costs = this.calculateCosts(fill, fill.size, fundingCost);

    const trade: CompletedTrade = {
      direction,
      entryPrice,
      exitPrice: fill.price,
      size: fill.size,
      pnl: costs.netPnl,
      pnlPct: costs.pnlPct,
      rMultiple: costs.rMultiple,
      entryTimestamp,
      exitTimestamp: fill.timestamp,
      entryBarIndex,
      exitBarIndex,
      barsHeld: exitBarIndex - entryBarIndex,
      exitType,
      commission: costs.commission,
      slippageCost: costs.slippageCost,
      fundingCost,
      entryComment,
      exitComment,
    };

    this.position.size -= fill.size;
    this.position.fills.push(fill);
    this.completedTrades.push(trade);

    return trade;
  }
}
