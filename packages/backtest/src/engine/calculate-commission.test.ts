import { describe, it, expect } from "vitest";
import { calculateCommission } from "./calculate-commission.js";

describe("calculateCommission", () => {
  it("calculates commission correctly", () => {
    expect(calculateCommission(100, 2, 0.1)).toBeCloseTo(0.2);
  });

  it("uses absolute value for negative size", () => {
    expect(calculateCommission(100, -2, 0.1)).toBeCloseTo(0.2);
  });

  it("returns 0 when commission is 0%", () => {
    expect(calculateCommission(50_000, 1, 0)).toBe(0);
  });
});
