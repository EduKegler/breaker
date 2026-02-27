import { describe, it, expect } from "vitest";
import {
  finiteOrThrow,
  finiteOr,
  assertPositive,
  isSanePrice,
  isSaneSize,
  isSaneEquity,
} from "./validators.js";

describe("finiteOrThrow", () => {
  it("returns the value when finite", () => {
    expect(finiteOrThrow(42, "test")).toBe(42);
    expect(finiteOrThrow(0, "test")).toBe(0);
    expect(finiteOrThrow(-5.5, "test")).toBe(-5.5);
  });

  it("throws on NaN", () => {
    expect(() => finiteOrThrow(NaN, "price")).toThrow("price: expected finite number, got NaN");
  });

  it("throws on Infinity", () => {
    expect(() => finiteOrThrow(Infinity, "size")).toThrow("size: expected finite number, got Infinity");
  });

  it("throws on -Infinity", () => {
    expect(() => finiteOrThrow(-Infinity, "pnl")).toThrow("pnl: expected finite number, got -Infinity");
  });
});

describe("finiteOr", () => {
  it("returns the value when finite", () => {
    expect(finiteOr(42, 0)).toBe(42);
    expect(finiteOr(-3, 0)).toBe(-3);
  });

  it("returns fallback on NaN", () => {
    expect(finiteOr(NaN, 0)).toBe(0);
  });

  it("returns fallback on Infinity", () => {
    expect(finiteOr(Infinity, -1)).toBe(-1);
  });

  it("returns fallback on -Infinity", () => {
    expect(finiteOr(-Infinity, 99)).toBe(99);
  });
});

describe("assertPositive", () => {
  it("returns value when positive", () => {
    expect(assertPositive(1, "test")).toBe(1);
    expect(assertPositive(0.001, "test")).toBe(0.001);
  });

  it("throws on zero", () => {
    expect(() => assertPositive(0, "leverage")).toThrow("leverage: expected positive number, got 0");
  });

  it("throws on negative", () => {
    expect(() => assertPositive(-1, "size")).toThrow("size: expected positive number, got -1");
  });

  it("throws on NaN", () => {
    expect(() => assertPositive(NaN, "test")).toThrow();
  });

  it("throws on Infinity", () => {
    expect(() => assertPositive(Infinity, "test")).toThrow();
  });
});

describe("isSanePrice", () => {
  it("accepts normal prices", () => {
    expect(isSanePrice(95000)).toBe(true);
    expect(isSanePrice(0.001)).toBe(true);
    expect(isSanePrice(9_999_999)).toBe(true);
  });

  it("rejects zero", () => {
    expect(isSanePrice(0)).toBe(false);
  });

  it("rejects negative", () => {
    expect(isSanePrice(-100)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isSanePrice(NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isSanePrice(Infinity)).toBe(false);
  });

  it("rejects absurdly high values", () => {
    expect(isSanePrice(10_000_000)).toBe(false);
    expect(isSanePrice(999_999_999)).toBe(false);
  });
});

describe("isSaneSize", () => {
  it("accepts normal sizes", () => {
    expect(isSaneSize(0.01)).toBe(true);
    expect(isSaneSize(0)).toBe(true);
    expect(isSaneSize(999_999)).toBe(true);
  });

  it("rejects negative", () => {
    expect(isSaneSize(-1)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isSaneSize(NaN)).toBe(false);
  });

  it("rejects absurdly high values", () => {
    expect(isSaneSize(1_000_000)).toBe(false);
  });
});

describe("isSaneEquity", () => {
  it("accepts normal equity", () => {
    expect(isSaneEquity(1000)).toBe(true);
    expect(isSaneEquity(0)).toBe(true);
    expect(isSaneEquity(-500)).toBe(true);
  });

  it("rejects NaN", () => {
    expect(isSaneEquity(NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isSaneEquity(Infinity)).toBe(false);
  });

  it("rejects extreme negative", () => {
    expect(isSaneEquity(-1_000_000)).toBe(false);
  });

  it("rejects extreme positive", () => {
    expect(isSaneEquity(100_000_000)).toBe(false);
  });
});
