import { describe, it, expect } from "vitest";
import { applySlippage } from "./apply-slippage.js";
import { calculateCommission } from "./calculate-commission.js";
import { DEFAULT_EXECUTION } from "./execution-model.js";

describe("applySlippage", () => {
  it("increases price for buy orders", () => {
    // 2 bps = 0.02%
    const result = applySlippage(10000, "buy", 2);
    expect(result).toBeCloseTo(10002, 2);
  });

  it("decreases price for sell orders", () => {
    const result = applySlippage(10000, "sell", 2);
    expect(result).toBeCloseTo(9998, 2);
  });

  it("returns exact price when slippage is 0", () => {
    expect(applySlippage(50000, "buy", 0)).toBe(50000);
    expect(applySlippage(50000, "sell", 0)).toBe(50000);
  });
});

describe("calculateCommission", () => {
  it("calculates correct commission", () => {
    // 0.045% of $10,000 notional
    const result = calculateCommission(10000, 1, 0.045);
    expect(result).toBeCloseTo(4.5, 5);
  });

  it("handles fractional sizes", () => {
    const result = calculateCommission(50000, 0.1, 0.045);
    // notional = 5000, commission = 5000 * 0.00045 = 2.25
    expect(result).toBeCloseTo(2.25, 5);
  });

  it("returns 0 when commission is 0", () => {
    expect(calculateCommission(10000, 1, 0)).toBe(0);
  });

  it("uses absolute value of notional", () => {
    const result = calculateCommission(10000, -1, 0.045);
    expect(result).toBeCloseTo(4.5, 5);
  });
});

describe("DEFAULT_EXECUTION", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_EXECUTION.slippageBps).toBe(2);
    expect(DEFAULT_EXECUTION.commissionPct).toBe(0.045);
  });
});
