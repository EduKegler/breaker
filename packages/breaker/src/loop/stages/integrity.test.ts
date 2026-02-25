import { describe, it, expect } from "vitest";
import { computeContentToken, validateTokenInFilename, validateIntegrity } from "./integrity.js";

describe("computeContentToken", () => {
  it("returns 8 uppercase hex chars", () => {
    const token = computeContentToken("some pine script content");
    expect(token).toMatch(/^[0-9A-F]{8}$/);
    expect(token).toHaveLength(8);
  });

  it("is deterministic for same content", () => {
    const content = "strategy('test') ...";
    expect(computeContentToken(content)).toBe(computeContentToken(content));
  });

  it("differs for different content", () => {
    const a = computeContentToken("strategy('a')");
    const b = computeContentToken("strategy('b')");
    expect(a).not.toBe(b);
  });
});

describe("validateTokenInFilename", () => {
  it("returns true when token is in filename", () => {
    expect(validateTokenInFilename("ABCD1234", "strategy [ABCD1234] - 2026.xlsx")).toBe(true);
  });

  it("returns false when token is missing", () => {
    expect(validateTokenInFilename("ABCD1234", "strategy - 2026.xlsx")).toBe(false);
  });
});

describe("validateIntegrity", () => {
  it("returns null when everything matches", () => {
    const result = validateIntegrity({
      contentToken: "ABCD1234",
      xlsxFilename: "strategy [ABCD1234] - 2026.xlsx",
      pineParams: { atrMult: 4.0, rr1: 0.5, rr2: 4.0, filters: {}, blockedHours: [], blockedDays: [] },
      xlsxParams: { riskTradeUsd: 5, atrMult: 4.0, maxBarsToTp1: 20, rr1: 0.5, rr2: 4.0, cooldownBars: 5 },
    });
    expect(result).toBeNull();
  });

  it("returns error when token not in filename", () => {
    const result = validateIntegrity({
      contentToken: "ABCD1234",
      xlsxFilename: "strategy - 2026.xlsx",
      pineParams: null,
      xlsxParams: null,
    });
    expect(result).toContain("INTEGRITY_MISMATCH");
    expect(result).toContain("ABCD1234");
  });

  it("returns error when numeric params mismatch", () => {
    const result = validateIntegrity({
      contentToken: "ABCD1234",
      xlsxFilename: "strategy [ABCD1234] - 2026.xlsx",
      pineParams: { atrMult: 4.0, rr1: 0.5, rr2: 4.0, filters: {}, blockedHours: [], blockedDays: [] },
      xlsxParams: { riskTradeUsd: 5, atrMult: 5.0, maxBarsToTp1: 20, rr1: 0.5, rr2: 4.0, cooldownBars: 5 },
    });
    expect(result).toContain("INTEGRITY_MISMATCH");
    expect(result).toContain("atrMult");
  });

  it("skips param check when pineParams is null", () => {
    const result = validateIntegrity({
      contentToken: "ABCD1234",
      xlsxFilename: "strategy [ABCD1234] - 2026.xlsx",
      pineParams: null,
      xlsxParams: null,
    });
    expect(result).toBeNull();
  });

  it("skips param check when xlsx values are null (plain constants, no inputs)", () => {
    const result = validateIntegrity({
      contentToken: "ABCD1234",
      xlsxFilename: "strategy [ABCD1234] - 2026.xlsx",
      pineParams: { atrMult: 4.5, rr1: 0.5, rr2: 4.0, filters: {}, blockedHours: [], blockedDays: [] },
      xlsxParams: { riskTradeUsd: null as unknown as number, atrMult: null as unknown as number, maxBarsToTp1: null as unknown as number, rr1: null as unknown as number, rr2: null as unknown as number, cooldownBars: null as unknown as number },
    });
    expect(result).toBeNull();
  });

  it("skips param check when xlsx values are NaN (explicit NaN, not just null)", () => {
    const result = validateIntegrity({
      contentToken: "ABCD1234",
      xlsxFilename: "strategy [ABCD1234] - 2026.xlsx",
      pineParams: { atrMult: 4.5, rr1: 0.5, rr2: 4.0, filters: {}, blockedHours: [], blockedDays: [] },
      xlsxParams: { riskTradeUsd: NaN, atrMult: NaN, maxBarsToTp1: NaN, rr1: NaN, rr2: NaN, cooldownBars: NaN },
    });
    expect(result).toBeNull();
  });
});
