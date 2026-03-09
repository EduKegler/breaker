import { describe, it, expect, beforeEach } from "vitest";
import { PendingEntryBook, type PendingEntry } from "./pending-entry-book.js";

function makePending(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    coin: "BTC",
    hlOrderId: 12345,
    direction: "long",
    size: 0.01,
    price: 60000,
    stopLoss: 59000,
    takeProfits: [{ price: 62000, pctOfPosition: 1 }],
    expiresAt: Date.now() + 30 * 60 * 1000,
    signalId: 1,
    leverage: 5,
    strategyName: "test-strat",
    comment: "breakout long",
    ...overrides,
  };
}

describe("PendingEntryBook", () => {
  let book: PendingEntryBook;

  beforeEach(() => {
    book = new PendingEntryBook();
  });

  it("starts empty", () => {
    expect(book.has("BTC")).toBe(false);
    expect(book.get("BTC")).toBeNull();
    expect(book.getAll()).toEqual([]);
  });

  it("adds and retrieves a pending entry", () => {
    const entry = makePending();
    book.add(entry);

    expect(book.has("BTC")).toBe(true);
    expect(book.get("BTC")).toEqual(entry);
    expect(book.getAll()).toEqual([entry]);
  });

  it("throws when adding duplicate coin", () => {
    book.add(makePending());
    expect(() => book.add(makePending())).toThrow("Pending entry already exists for BTC");
  });

  it("removes a pending entry and returns it", () => {
    const entry = makePending();
    book.add(entry);

    const removed = book.remove("BTC");
    expect(removed).toEqual(entry);
    expect(book.has("BTC")).toBe(false);
  });

  it("returns null when removing non-existent coin", () => {
    expect(book.remove("ETH")).toBeNull();
  });

  it("tracks multiple coins independently", () => {
    const btc = makePending({ coin: "BTC" });
    const eth = makePending({ coin: "ETH", hlOrderId: 99999 });

    book.add(btc);
    book.add(eth);

    expect(book.has("BTC")).toBe(true);
    expect(book.has("ETH")).toBe(true);
    expect(book.getAll()).toHaveLength(2);

    book.remove("BTC");
    expect(book.has("BTC")).toBe(false);
    expect(book.has("ETH")).toBe(true);
  });

  it("getExpired returns only expired entries", () => {
    const now = Date.now();
    const expired = makePending({ coin: "BTC", expiresAt: now - 1000 });
    const active = makePending({ coin: "ETH", hlOrderId: 99, expiresAt: now + 60000 });

    book.add(expired);
    book.add(active);

    const result = book.getExpired(now);
    expect(result).toEqual([expired]);
  });

  it("getExpired returns empty when nothing expired", () => {
    const now = Date.now();
    book.add(makePending({ expiresAt: now + 60000 }));
    expect(book.getExpired(now)).toEqual([]);
  });

  it("getExpired includes exactly-at-expiry entries", () => {
    const now = Date.now();
    book.add(makePending({ expiresAt: now }));
    expect(book.getExpired(now)).toHaveLength(1);
  });

  it("findByOrderId returns matching entry", () => {
    const entry = makePending({ hlOrderId: 42 });
    book.add(entry);
    expect(book.findByOrderId(42)).toEqual(entry);
  });

  it("findByOrderId returns null for unknown id", () => {
    expect(book.findByOrderId(999)).toBeNull();
  });

  it("count returns number of pending entries", () => {
    expect(book.count()).toBe(0);
    book.add(makePending({ coin: "BTC" }));
    expect(book.count()).toBe(1);
    book.add(makePending({ coin: "ETH", hlOrderId: 99 }));
    expect(book.count()).toBe(2);
    book.remove("BTC");
    expect(book.count()).toBe(1);
  });
});
