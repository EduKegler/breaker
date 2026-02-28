import { describe, it, expect } from "vitest";
import { checkRisk, type RiskCheckInput } from "./check-risk.js";
import type { Guardrails } from "../types/config.js";

const guardrails: Guardrails = {
  maxNotionalUsd: 5000,
  maxLeverage: 5,
  maxOpenPositions: 1,
  maxDailyLossUsd: 100,
  maxTradesPerDay: 5,
  cooldownBars: 4,
};

const safeInput: RiskCheckInput = {
  notionalUsd: 1000,
  leverage: 5,
  openPositions: 0,
  dailyLossUsd: 0,
  tradesToday: 0,
};

describe("checkRisk", () => {
  it("passes when all conditions are within limits", () => {
    const result = checkRisk(safeInput, guardrails);
    expect(result.passed).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("fails when notional exceeds max", () => {
    const result = checkRisk({ ...safeInput, notionalUsd: 6000 }, guardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Notional");
  });

  it("fails when leverage exceeds max", () => {
    const result = checkRisk({ ...safeInput, leverage: 10 }, guardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Leverage");
  });

  it("fails when open positions at max", () => {
    const result = checkRisk({ ...safeInput, openPositions: 1 }, guardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Open positions");
  });

  it("fails when daily loss at max", () => {
    const result = checkRisk({ ...safeInput, dailyLossUsd: 100 }, guardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Daily loss");
  });

  it("fails when trades today at max", () => {
    const result = checkRisk({ ...safeInput, tradesToday: 5 }, guardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Trades today");
  });

  it("returns first failing check (priority order)", () => {
    const result = checkRisk({
      notionalUsd: 10000,
      leverage: 20,
      openPositions: 5,
      dailyLossUsd: 500,
      tradesToday: 10,
    }, guardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Notional");
  });

  // Kill switch: maxTradesPerDay = 0 blocks all trades
  it("blocks all trades when maxTradesPerDay is 0 (kill switch)", () => {
    const killSwitchGuardrails: Guardrails = { ...guardrails, maxTradesPerDay: 0 };
    const result = checkRisk({ ...safeInput, tradesToday: 0 }, killSwitchGuardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Trades today");
  });

  // Absolute cap: notional > 100k rejected regardless of config
  it("rejects notional above absolute cap even with high config limit", () => {
    const permissiveGuardrails: Guardrails = { ...guardrails, maxNotionalUsd: 500_000 };
    const result = checkRisk({ ...safeInput, notionalUsd: 150_000 }, permissiveGuardrails);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("absolute cap");
  });

  it("allows notional just under absolute cap", () => {
    const permissiveGuardrails: Guardrails = { ...guardrails, maxNotionalUsd: 500_000 };
    const result = checkRisk({ ...safeInput, notionalUsd: 99_999 }, permissiveGuardrails);
    expect(result.passed).toBe(true);
  });

  // Price sanity check
  it("rejects entry price deviating >5% from current price", () => {
    const result = checkRisk(
      { ...safeInput, entryPrice: 110, currentPrice: 100 },
      guardrails,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("deviates");
    expect(result.reason).toContain("10.0%");
  });

  it("allows entry price within 5% of current price", () => {
    const result = checkRisk(
      { ...safeInput, entryPrice: 103, currentPrice: 100 },
      guardrails,
    );
    expect(result.passed).toBe(true);
  });

  it("skips price check when currentPrice is 0", () => {
    const result = checkRisk(
      { ...safeInput, entryPrice: 110, currentPrice: 0 },
      guardrails,
    );
    expect(result.passed).toBe(true);
  });

  it("skips price check when prices are not provided", () => {
    const result = checkRisk(safeInput, guardrails);
    expect(result.passed).toBe(true);
  });

  it("rejects entry price below current by >5%", () => {
    const result = checkRisk(
      { ...safeInput, entryPrice: 90, currentPrice: 100 },
      guardrails,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("deviates");
  });
});
