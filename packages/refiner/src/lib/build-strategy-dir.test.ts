import { describe, it, expect } from "vitest";
import { buildStrategyDir } from "./build-strategy-dir.js";

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
