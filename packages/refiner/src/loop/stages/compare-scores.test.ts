import { describe, it, expect } from "vitest";
import { compareScores } from "./compare-scores.js";

describe("compareScores", () => {
  it("accepts when new > old * 1.02", () => {
    expect(compareScores(55, 50)).toBe("accept");
  });

  it("rejects when new < old * 0.85", () => {
    expect(compareScores(40, 50)).toBe("reject");
  });

  it("neutral when in between", () => {
    expect(compareScores(50, 50)).toBe("neutral");
  });

  it("accepts when old is 0 and new is positive", () => {
    expect(compareScores(10, 0)).toBe("accept");
  });

  it("neutral when both are 0", () => {
    expect(compareScores(0, 0)).toBe("neutral");
  });
});
