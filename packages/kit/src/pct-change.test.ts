import { describe, it, expect } from "vitest";
import { pctChange } from "./pct-change.js";

describe("pctChange", () => {
  it("returns positive change", () => {
    expect(pctChange(110, 100)).toBe(10);
  });

  it("returns negative change", () => {
    expect(pctChange(90, 100)).toBe(-10);
  });

  it("returns zero when no change", () => {
    expect(pctChange(100, 100)).toBe(0);
  });

  it("returns Infinity when baseline is zero", () => {
    expect(pctChange(10, 0)).toBe(Infinity);
  });
});
