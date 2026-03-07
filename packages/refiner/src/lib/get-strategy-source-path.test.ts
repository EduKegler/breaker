import { describe, it, expect } from "vitest";
import path from "node:path";
import { getStrategySourcePath } from "./get-strategy-source-path.js";

describe("getStrategySourcePath", () => {
  it("maps createDonchianAdx to btc/breakout/donchian-adx.ts", () => {
    const result = getStrategySourcePath("/repo/packages/refiner", "createDonchianAdx");
    expect(result).toBe(path.join("/repo", "packages", "backtest", "src", "strategies", "btc", "breakout", "donchian-adx.ts"));
  });

  it("throws for unknown factory name", () => {
    expect(() => getStrategySourcePath("/repo/packages/refiner", "createUnknown")).toThrow(
      /Unknown strategy factory/,
    );
  });
});
