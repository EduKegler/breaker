import { describe, it, expect } from "vitest";
import { applySlippage } from "./apply-slippage.js";

describe("applySlippage", () => {
  it("increases price for buy orders", () => {
    expect(applySlippage(100, "buy", 10)).toBeCloseTo(100.1);
  });

  it("decreases price for sell orders", () => {
    expect(applySlippage(100, "sell", 10)).toBeCloseTo(99.9);
  });

  it("returns original price when slippage is 0", () => {
    expect(applySlippage(50_000, "buy", 0)).toBe(50_000);
    expect(applySlippage(50_000, "sell", 0)).toBe(50_000);
  });
});
