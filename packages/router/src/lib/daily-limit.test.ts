import { describe, it, expect, beforeEach, vi } from "vitest";
import { DailyTradeLimit } from "./daily-limit.js";

describe("DailyTradeLimit", () => {
  let limiter: DailyTradeLimit;

  beforeEach(() => {
    limiter = new DailyTradeLimit(5);
  });

  it("allows trades under the limit", () => {
    const result = limiter.check();
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(0);
    expect(result.limit).toBe(5);
  });

  it("increments counter on record()", () => {
    limiter.record();
    limiter.record();
    const result = limiter.check();
    expect(result.count).toBe(2);
    expect(result.allowed).toBe(true);
  });

  it("rejects when limit is reached", () => {
    for (let i = 0; i < 5; i++) limiter.record();
    const result = limiter.check();
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(5);
  });

  it("rejects when limit is exceeded", () => {
    for (let i = 0; i < 6; i++) limiter.record();
    const result = limiter.check();
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(6);
  });

  it("resets counter at UTC day boundary", () => {
    for (let i = 0; i < 5; i++) limiter.record();
    expect(limiter.check().allowed).toBe(false);

    // Simulate next UTC day
    vi.useFakeTimers();
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 1, 0); // 00:00:01 UTC next day
    vi.setSystemTime(tomorrow);

    const result = limiter.check();
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(0);

    vi.useRealTimers();
  });

  it("keeps count within same UTC day", () => {
    vi.useFakeTimers();
    const today = new Date("2026-02-26T10:00:00Z");
    vi.setSystemTime(today);

    limiter.record();
    limiter.record();

    // Later same UTC day
    vi.setSystemTime(new Date("2026-02-26T23:59:59Z"));

    expect(limiter.check().count).toBe(2);
    expect(limiter.check().allowed).toBe(true);

    vi.useRealTimers();
  });

  it("uses custom limit", () => {
    const strict = new DailyTradeLimit(2);
    strict.record();
    strict.record();
    expect(strict.check().allowed).toBe(false);
  });

  it("getStatus returns current day key and count", () => {
    limiter.record();
    const status = limiter.getStatus();
    expect(status.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(status.count).toBe(1);
    expect(status.limit).toBe(5);
    expect(status.remaining).toBe(4);
  });
});
