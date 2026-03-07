import { describe, it, expect } from "vitest";
import path from "node:path";
import { getStrategySourcePath, factoryToKebab } from "./get-strategy-source-path.js";

describe("factoryToKebab", () => {
  it("converts createDonchianAdx → donchian-adx", () => {
    expect(factoryToKebab("createDonchianAdx")).toBe("donchian-adx");
  });

  it("converts createKeltnerRsi2 → keltner-rsi2", () => {
    expect(factoryToKebab("createKeltnerRsi2")).toBe("keltner-rsi2");
  });

  it("converts createEmaPullback → ema-pullback", () => {
    expect(factoryToKebab("createEmaPullback")).toBe("ema-pullback");
  });

  it("handles single-word names", () => {
    expect(factoryToKebab("createDonchian")).toBe("donchian");
  });
});

describe("getStrategySourcePath", () => {
  it("maps createDonchianAdx + BTC/breakout to correct path", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createDonchianAdx", "BTC", "breakout");
    expect(result).toBe(path.join("/repo", "packages", "backtest", "src", "strategies", "btc", "breakout", "donchian-adx.ts"));
  });

  it("maps createKeltnerRsi2 + BTC/mean-reversion to correct path", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createKeltnerRsi2", "BTC", "mean-reversion");
    expect(result).toBe(path.join("/repo", "packages", "backtest", "src", "strategies", "btc", "mean-reversion", "keltner-rsi2.ts"));
  });

  it("lowercases coin for asset directory", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createEmaPullback", "SOL", "pullback");
    expect(result).toContain(path.join("sol", "pullback", "ema-pullback.ts"));
  });
});
