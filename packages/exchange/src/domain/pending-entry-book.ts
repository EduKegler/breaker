export interface PendingEntry {
  coin: string;
  hlOrderId: number;
  direction: "long" | "short";
  size: number;
  price: number;
  stopLoss: number;
  takeProfits: { price: number; pctOfPosition: number }[];
  expiresAt: number;
  signalId: number;
  leverage: number;
  strategyName: string | null;
  comment: string;
}

export class PendingEntryBook {
  private entries = new Map<string, PendingEntry>();

  add(entry: PendingEntry): void {
    if (this.entries.has(entry.coin)) {
      throw new Error(`Pending entry already exists for ${entry.coin}`);
    }
    this.entries.set(entry.coin, entry);
  }

  remove(coin: string): PendingEntry | null {
    const entry = this.entries.get(coin) ?? null;
    if (entry) this.entries.delete(coin);
    return entry;
  }

  get(coin: string): PendingEntry | null {
    return this.entries.get(coin) ?? null;
  }

  has(coin: string): boolean {
    return this.entries.has(coin);
  }

  getAll(): PendingEntry[] {
    return Array.from(this.entries.values());
  }

  getExpired(now: number): PendingEntry[] {
    return this.getAll().filter((e) => e.expiresAt <= now);
  }

  findByOrderId(hlOrderId: number): PendingEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.hlOrderId === hlOrderId) return entry;
    }
    return null;
  }

  count(): number {
    return this.entries.size;
  }
}
