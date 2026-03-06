import { describe, it, expect } from "vitest";
import { phaseHelpers } from "./phase-helpers.js";

describe("computeEffectiveVerdict", () => {
  it("preserves accept when meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("accept", true)).toBe("accept");
  });

  it("preserves neutral when meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("neutral", true)).toBe("neutral");
  });

  it("preserves reject when meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("reject", true)).toBe("reject");
  });

  it("downgrades accept to neutral when !meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("accept", false)).toBe("neutral");
  });

  it("downgrades neutral to reject when !meetsMinTrades (Bug A: cascading degradation)", () => {
    // Before fix: neutral stayed neutral, no rollback happened, allowing
    // a 30-trade strategy (below minTrades=50) to survive and further degrade to 2 trades.
    expect(phaseHelpers.computeEffectiveVerdict("neutral", false)).toBe("reject");
  });

  it("keeps reject as reject when !meetsMinTrades", () => {
    expect(phaseHelpers.computeEffectiveVerdict("reject", false)).toBe("reject");
  });
});
