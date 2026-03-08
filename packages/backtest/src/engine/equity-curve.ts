export interface EquityPoint {
  timestamp: number;
  barIndex: number;
  equity: number;
  drawdown: number; // 0 to -1 fraction (can exceed -1 if equity goes negative)
}

export class EquityCurve {
  private points: EquityPoint[] = [];
  private peak: number;
  private current: number;
  private maxDrawdownFrac: number = 0;

  constructor(private initialCapital: number) {
    this.peak = initialCapital;
    this.current = initialCapital;
  }

  record(timestamp: number, barIndex: number, pnlDelta: number): void {
    this.current += pnlDelta;
    if (this.current > this.peak) {
      this.peak = this.current;
    }
    const drawdown = this.peak > 0 ? (this.current - this.peak) / this.peak : 0;
    if (drawdown < this.maxDrawdownFrac) {
      this.maxDrawdownFrac = drawdown;
    }
    this.points.push({
      timestamp,
      barIndex,
      equity: this.current,
      drawdown,
    });
  }

  getEquity(): number {
    return this.current;
  }

  getPeak(): number {
    return this.peak;
  }

  getCurrentDrawdown(): number {
    return this.peak > 0 ? (this.current - this.peak) / this.peak : 0;
  }

  getMaxDrawdownPct(): number {
    return this.maxDrawdownFrac * 100; // Return as percentage (negative number)
  }

  getPoints(): EquityPoint[] {
    return [...this.points];
  }

  getTotalReturn(): number {
    return this.current - this.initialCapital;
  }

  getTotalReturnPct(): number {
    return this.initialCapital > 0
      ? ((this.current - this.initialCapital) / this.initialCapital) * 100
      : 0;
  }
}
