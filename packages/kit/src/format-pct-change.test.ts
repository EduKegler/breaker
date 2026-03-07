import { describe, it, expect } from "vitest";
import { formatPctChange } from "./format-pct-change.js";

describe("formatPctChange", () => {
  it("positive shows '+' prefix", () => {
    expect(formatPctChange(2.5)).toBe("+2.50%");
  });

  it("negative shows '-' prefix", () => {
    expect(formatPctChange(-1.3)).toBe("-1.30%");
  });

  it("zero shows '+0.00%'", () => {
    expect(formatPctChange(0)).toBe("+0.00%");
  });

  it("custom decimals", () => {
    expect(formatPctChange(2.5, 1)).toBe("+2.5%");
    expect(formatPctChange(-3.456, 3)).toBe("-3.456%");
  });
});
