import { describe, it, expect } from "vitest";
import path from "node:path";
import { getStrategySourcePath, factoryToKebab } from "./get-strategy-source-path.js";

describe("factoryToKebab", () => {
  it("converts createTestStrategy → test-strategy", () => {
    expect(factoryToKebab("createTestStrategy")).toBe("test-strategy");
  });

  it("converts createTestMeanReversion → test-mean-reversion", () => {
    expect(factoryToKebab("createTestMeanReversion")).toBe("test-mean-reversion");
  });

  it("converts createTestPullback → test-pullback", () => {
    expect(factoryToKebab("createTestPullback")).toBe("test-pullback");
  });

  it("handles single-word names", () => {
    expect(factoryToKebab("createDonchian")).toBe("donchian");
  });
});

describe("getStrategySourcePath", () => {
  it("maps createTestStrategy + BTC/breakout to correct path", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createTestStrategy", "BTC", "breakout");
    expect(result).toBe(path.join("/repo", "packages", "backtest", "src", "strategies", "btc", "breakout", "test-strategy.ts"));
  });

  it("maps createTestMeanReversion + BTC/mean-reversion to correct path", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createTestMeanReversion", "BTC", "mean-reversion");
    expect(result).toBe(path.join("/repo", "packages", "backtest", "src", "strategies", "btc", "mean-reversion", "test-mean-reversion.ts"));
  });

  it("lowercases coin for asset directory", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createTestPullback", "SOL", "pullback");
    expect(result).toContain(path.join("sol", "pullback", "test-pullback.ts"));
  });
});
