import { describe, it, expect } from "vitest";
import { strategyRegistry } from "./strategy-registry.js";

describe("strategyRegistry.get", () => {
  it("throws for unknown factory name (registry is empty)", () => {
    expect(() => strategyRegistry.get("nonExistent")).toThrow(
      /Unknown strategy factory "nonExistent"/,
    );
  });
});

describe("strategyRegistry.list", () => {
  it("returns empty list (all strategies use dynamic import)", () => {
    const names = strategyRegistry.list();
    expect(names).toEqual([]);
  });
});
