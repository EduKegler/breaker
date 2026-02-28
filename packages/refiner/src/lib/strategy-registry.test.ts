import { describe, it, expect } from "vitest";
import { strategyRegistry } from "./strategy-registry.js";

describe("strategyRegistry.get", () => {
  it("returns createDonchianAdx factory", () => {
    const factory = strategyRegistry.get("createDonchianAdx");
    expect(typeof factory).toBe("function");
    const strategy = factory();
    expect(strategy.name).toBe("BTC 15m Breakout — Donchian ADX");
    expect(strategy.params).toBeDefined();
    expect(strategy.params.dcSlow).toBeDefined();
  });

  it("returns createKeltnerRsi2 factory", () => {
    const factory = strategyRegistry.get("createKeltnerRsi2");
    expect(typeof factory).toBe("function");
    const strategy = factory();
    expect(strategy.name).toBe("BTC 15m Mean Reversion — Keltner RSI2");
    expect(strategy.params).toBeDefined();
  });

  it("throws for unknown factory name", () => {
    expect(() => strategyRegistry.get("nonExistent")).toThrow(
      /Unknown strategy factory "nonExistent"/,
    );
  });

  it("passes param overrides to factory", () => {
    const factory = strategyRegistry.get("createDonchianAdx");
    const strategy = factory({ dcSlow: 55 });
    expect(strategy.params.dcSlow.value).toBe(55);
  });
});

describe("strategyRegistry.list", () => {
  it("returns all registered factory names", () => {
    const names = strategyRegistry.list();
    expect(names).toContain("createDonchianAdx");
    expect(names).toContain("createKeltnerRsi2");
    expect(names.length).toBe(2);
  });
});
