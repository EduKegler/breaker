import { describe, it, expect } from "vitest";
import { strategyRegistry } from "./strategy-registry.js";

describe("strategyRegistry.get", () => {
  it("returns createDonchianAdx factory", () => {
    const factory = strategyRegistry.get("createDonchianAdx");
    expect(typeof factory).toBe("function");
    const strategy = factory();
    expect(strategy.name).toMatch(/^BTC 15m Breakout/);
    expect(strategy.params).toBeDefined();
    expect(strategy.params.bbKcPeriod).toBeDefined();
  });

  it("throws for unknown factory name", () => {
    expect(() => strategyRegistry.get("nonExistent")).toThrow(
      /Unknown strategy factory "nonExistent"/,
    );
  });

  it("passes param overrides to factory", () => {
    const factory = strategyRegistry.get("createDonchianAdx");
    const strategy = factory({ bbKcPeriod: 24 });
    expect(strategy.params.bbKcPeriod.value).toBe(24);
  });
});

describe("strategyRegistry.list", () => {
  it("returns all registered factory names", () => {
    const names = strategyRegistry.list();
    expect(names).toContain("createDonchianAdx");
    expect(names.length).toBe(1);
  });
});
