export interface LivePosition {
  coin: string;
  direction: "long" | "short";
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: string;
  signalId: number;
}

export class PositionBook {
  private positions = new Map<string, LivePosition>();

  open(position: Omit<LivePosition, "currentPrice" | "unrealizedPnl">): void {
    if (this.positions.has(position.coin)) {
      throw new Error(`Position already open for ${position.coin}`);
    }
    this.positions.set(position.coin, {
      ...position,
      currentPrice: position.entryPrice,
      unrealizedPnl: 0,
    });
  }

  close(coin: string): LivePosition | null {
    const pos = this.positions.get(coin);
    if (!pos) return null;
    this.positions.delete(coin);
    return pos;
  }

  updatePrice(coin: string, price: number): void {
    const pos = this.positions.get(coin);
    if (!pos) return;
    pos.currentPrice = price;
    pos.unrealizedPnl =
      pos.direction === "long"
        ? (price - pos.entryPrice) * pos.size
        : (pos.entryPrice - price) * pos.size;
  }

  get(coin: string): LivePosition | null {
    return this.positions.get(coin) ?? null;
  }

  getAll(): LivePosition[] {
    return Array.from(this.positions.values());
  }

  count(): number {
    return this.positions.size;
  }

  isFlat(coin: string): boolean {
    return !this.positions.has(coin);
  }
}
