import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildStrategyDir, getStrategySourcePath } from "./strategy-path.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

describe("buildStrategyDir", () => {
  it("builds path with asset and strategy", () => {
    expect(buildStrategyDir("/repo", "BTC", "breakout")).toBe(
      "/repo/assets/btc/breakout",
    );
  });

  it("handles different asset and strategy names", () => {
    expect(buildStrategyDir("/repo", "ETH", "mean-reversion")).toBe(
      "/repo/assets/eth/mean-reversion",
    );
  });
});

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
