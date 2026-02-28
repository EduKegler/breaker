import { describe, it, expect } from "vitest";
import path from "node:path";
import { getStrategySourcePath } from "./get-strategy-source-path.js";

describe("getStrategySourcePath", () => {
  it("maps createDonchianAdx to donchian-adx.ts", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createDonchianAdx");
    expect(result).toBe(path.join("/repo", "packages", "backtest", "src", "strategies", "donchian-adx.ts"));
  });

  it("maps createKeltnerRsi2 to keltner-rsi2.ts", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createKeltnerRsi2");
    expect(result).toBe(path.join("/repo", "packages", "backtest", "src", "strategies", "keltner-rsi2.ts"));
  });

  it("throws for unknown factory name", () => {
    expect(() => getStrategySourcePath("/repo/packages/refiner", "createUnknown")).toThrow(
      /Unknown strategy factory/,
    );
  });
});
