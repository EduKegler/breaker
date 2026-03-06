import { describe, it, expect } from "vitest";
import { compareScores } from "./compare-scores.js";

describe("compareScores", () => {
  it("accepts when new > old * 1.02", () => {
    expect(compareScores(55, 50)).toBe("accept");
  });

  it("rejects when new < old * 0.97", () => {
    expect(compareScores(48, 50)).toBe("reject");
  });

  it("neutral when in between", () => {
    expect(compareScores(49, 50)).toBe("neutral");
  });

  it("rejects 4% degradation (was neutral with old 8% band)", () => {
    // 50 * 0.97 = 48.5 — score of 48 is below, so reject
    expect(compareScores(48, 50)).toBe("reject");
  });

  it("accepts when old is 0 and new is positive", () => {
    expect(compareScores(10, 0)).toBe("accept");
  });

  it("neutral when both are 0", () => {
    expect(compareScores(0, 0)).toBe("neutral");
  });
});
