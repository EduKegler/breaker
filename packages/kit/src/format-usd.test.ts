import { describe, it, expect } from "vitest";
import { formatUsd } from "./format-usd.js";

describe("formatUsd", () => {
  it("formats a positive number", () => {
    expect(formatUsd(1234.56)).toBe("$1,234.56");
  });

  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats a negative number", () => {
    expect(formatUsd(-42.1)).toBe("-$42.10");
  });

  it("formats a large number with commas", () => {
    expect(formatUsd(1000000)).toBe("$1,000,000.00");
  });
});
