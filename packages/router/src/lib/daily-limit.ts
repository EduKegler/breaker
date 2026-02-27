/**
 * Global daily trade limiter.
 * Tracks trade signals per UTC day and enforces a maximum.
 * In-memory counter with automatic reset at UTC day boundary.
 */

function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

interface DailyLimitCheck {
  allowed: boolean;
  count: number;
  limit: number;
}

interface DailyLimitStatus {
  dayKey: string;
  count: number;
  limit: number;
  remaining: number;
}

export class DailyTradeLimit {
  private counts = new Map<string, number>();

  constructor(private readonly maxTradesDay: number) {}

  /** Check if another trade is allowed today. */
  check(): DailyLimitCheck {
    const key = utcDayKey();
    this.pruneOldDays(key);
    const count = this.counts.get(key) ?? 0;
    return {
      allowed: count < this.maxTradesDay,
      count,
      limit: this.maxTradesDay,
    };
  }

  /** Record a trade that was successfully sent. */
  record(): void {
    const key = utcDayKey();
    this.pruneOldDays(key);
    const count = this.counts.get(key) ?? 0;
    this.counts.set(key, count + 1);
  }

  /** Get current status for health/debug endpoints. */
  getStatus(): DailyLimitStatus {
    const key = utcDayKey();
    this.pruneOldDays(key);
    const count = this.counts.get(key) ?? 0;
    return {
      dayKey: key,
      count,
      limit: this.maxTradesDay,
      remaining: Math.max(0, this.maxTradesDay - count),
    };
  }

  /** Remove entries from previous days to prevent memory leak. */
  private pruneOldDays(currentKey: string): void {
    for (const key of this.counts.keys()) {
      if (key !== currentKey) this.counts.delete(key);
    }
  }
}
