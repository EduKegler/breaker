import { describe, it, expect } from "vitest";
import { bakeParamDefaults } from "./bake-param-defaults.js";

const SAMPLE_SOURCE = `const DEFAULT_PARAMS = {
  bbKcPeriod: { value: 20, min: 14, max: 30, step: 2, optimizable: true, description: "Shared period" },
  kcMult: { value: 1.5, min: 1, max: 2.5, step: 0.25, optimizable: true, description: "KC ATR mult" },
  volMult: { value: 1.5, min: 1, max: 3, step: 0.5, optimizable: true, description: "Volume mult" },
  tpRR: { value: 2, min: 1.5, max: 3, step: 0.5, optimizable: true, description: "TP R:R" },
  timeoutBars: { value: 48, min: 24, max: 96, step: 8, optimizable: true, description: "Timeout" },
};`;

describe("bakeParamDefaults", () => {
  it("replaces value for existing params", () => {
    const { source, applied, stale } = bakeParamDefaults(SAMPLE_SOURCE, { volMult: 2, tpRR: 1.5 });

    expect(source).toContain("volMult: { value: 2,");
    expect(source).toContain("tpRR: { value: 1.5,");
    expect(applied).toEqual(["volMult", "tpRR"]);
    expect(stale).toEqual([]);
  });

  it("reports stale params that do not exist in source", () => {
    const { source, applied, stale } = bakeParamDefaults(SAMPLE_SOURCE, { dcSlow: 55, volMult: 2 });

    expect(source).toContain("volMult: { value: 2,");
    expect(applied).toEqual(["volMult"]);
    expect(stale).toEqual(["dcSlow"]);
  });

  it("does not modify unrelated params", () => {
    const { source } = bakeParamDefaults(SAMPLE_SOURCE, { volMult: 2 });

    expect(source).toContain("bbKcPeriod: { value: 20,");
    expect(source).toContain("kcMult: { value: 1.5,");
    expect(source).toContain("tpRR: { value: 2,");
    expect(source).toContain("timeoutBars: { value: 48,");
  });

  it("handles integer to float replacement", () => {
    const { source } = bakeParamDefaults(SAMPLE_SOURCE, { bbKcPeriod: 24 });
    expect(source).toContain("bbKcPeriod: { value: 24,");
  });

  it("handles float to integer replacement", () => {
    const { source } = bakeParamDefaults(SAMPLE_SOURCE, { kcMult: 2 });
    expect(source).toContain("kcMult: { value: 2,");
  });

  it("returns unchanged source and empty arrays for empty overrides", () => {
    const { source, applied, stale } = bakeParamDefaults(SAMPLE_SOURCE, {});
    expect(source).toBe(SAMPLE_SOURCE);
    expect(applied).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("returns all stale when no params match", () => {
    const { source, applied, stale } = bakeParamDefaults(SAMPLE_SOURCE, { dcSlow: 55, adxThreshold: 25 });
    expect(source).toBe(SAMPLE_SOURCE);
    expect(applied).toEqual([]);
    expect(stale).toEqual(["dcSlow", "adxThreshold"]);
  });

  it("handles multi-line param definitions", () => {
    const multiLineSource = `const DEFAULT_PARAMS = {
  volMult: {
    value: 1.5,
    min: 1,
    max: 3,
  },
};`;
    const { source, applied } = bakeParamDefaults(multiLineSource, { volMult: 2.5 });
    expect(source).toContain("value: 2.5,");
    expect(applied).toEqual(["volMult"]);
  });
});
