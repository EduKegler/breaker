import { describe, it, expect } from "vitest";
import { truncateSize, truncatePrice } from "./precision.js";

describe("truncateSize", () => {
  it("truncates to szDecimals (floor)", () => {
    expect(truncateSize(0.01234, 4)).toBe(0.0123);
    expect(truncateSize(0.01239, 4)).toBe(0.0123);
    expect(truncateSize(1.555, 2)).toBe(1.55);
  });

  it("returns 0 for sizes smaller than 1 unit at szDecimals", () => {
    expect(truncateSize(0.00009, 4)).toBe(0);
    expect(truncateSize(0.0001, 4)).toBe(0.0001);
  });

  it("handles zero and negative", () => {
    expect(truncateSize(0, 4)).toBe(0);
    expect(truncateSize(-1.234, 2)).toBe(-1.24); // floor of negative → more negative
  });

  it("handles szDecimals=0 (whole units only)", () => {
    expect(truncateSize(1.9, 0)).toBe(1);
    expect(truncateSize(0.5, 0)).toBe(0);
  });

  it("is idempotent (double truncation returns same value)", () => {
    const first = truncateSize(0.01234, 4);
    const second = truncateSize(first, 4);
    expect(second).toBe(first);
  });

  it("handles large values", () => {
    expect(truncateSize(12345.6789, 2)).toBe(12345.67);
  });

  it("handles szDecimals=5 (default fallback)", () => {
    expect(truncateSize(0.123456789, 5)).toBe(0.12345);
  });
});

describe("truncatePrice", () => {
  it("truncates to 5 significant figures", () => {
    expect(truncatePrice(95123.456)).toBe(95123);
    expect(truncatePrice(3500.123)).toBe(3500.1);
    expect(truncatePrice(0.12345678)).toBe(0.12346); // toPrecision rounds
  });

  it("preserves values already within 5 sig figs", () => {
    expect(truncatePrice(95000)).toBe(95000);
    expect(truncatePrice(100)).toBe(100);
  });

  it("is idempotent", () => {
    const first = truncatePrice(95123.456);
    const second = truncatePrice(first);
    expect(second).toBe(first);
  });

  it("handles small prices", () => {
    expect(truncatePrice(0.00012345)).toBe(0.00012345);
    expect(truncatePrice(0.000123456)).toBe(0.00012346);
  });

  it("handles zero", () => {
    expect(truncatePrice(0)).toBe(0);
  });
});
