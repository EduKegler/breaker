import { describe, it, expect } from "vitest";
import { validateGuardrails, validateParamGuardrails, countDayOfWeekUsage, extractStrategyCategory } from "./guardrails.js";
import type { Guardrails } from "../../types/config.js";
import type { StrategyParam } from "@breaker/backtest";

const defaultGuardrails: Guardrails = {
  maxRiskTradeUsd: 25,
  globalMaxTradesDay: 5,
  protectedFields: ["maxTradesDay"],
};

function mkParam(value: number, min = 0, max = 100, step = 1): StrategyParam {
  return { value, min, max, step, optimizable: true };
}

describe("validateParamGuardrails", () => {
  it("returns empty when no violations", () => {
    const before = { dcSlow: mkParam(50, 30, 60) };
    const after = { dcSlow: mkParam(55, 30, 60) };
    expect(validateParamGuardrails(before, after, defaultGuardrails)).toEqual([]);
  });

  it("detects protected field change", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, protectedFields: ["fixedParam"] };
    const before = { fixedParam: mkParam(10) };
    const after = { fixedParam: mkParam(20) };
    const v = validateParamGuardrails(before, after, guardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("fixedParam");
  });

  it("detects atrStopMult exceeding maxAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, maxAtrMult: 8 };
    const before = { atrStopMult: mkParam(4, 1, 10) };
    const after = { atrStopMult: mkParam(9, 1, 10) };
    const v = validateParamGuardrails(before, after, guardrails);
    expect(v.some((vi) => vi.field === "atrStopMult" && vi.reason.includes("Exceeds max"))).toBe(true);
  });

  it("detects atrStopMult below minAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, minAtrMult: 1.5 };
    const before = { atrStopMult: mkParam(3, 0.5, 10) };
    const after = { atrStopMult: mkParam(0.8, 0.5, 10) };
    const v = validateParamGuardrails(before, after, guardrails);
    expect(v.some((vi) => vi.field === "atrStopMult" && vi.reason.includes("Below min"))).toBe(true);
  });

  it("detects param below declared min", () => {
    const before = { dcSlow: mkParam(50, 30, 60) };
    const after = { dcSlow: mkParam(25, 30, 60) };
    const v = validateParamGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "dcSlow" && vi.reason.includes("Below declared min"))).toBe(true);
  });

  it("detects param above declared max", () => {
    const before = { dcSlow: mkParam(50, 30, 60) };
    const after = { dcSlow: mkParam(65, 30, 60) };
    const v = validateParamGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "dcSlow" && vi.reason.includes("Above declared max"))).toBe(true);
  });
});

describe("validateGuardrails (legacy)", () => {
  it("returns empty when no violations", () => {
    const before = `maxTradesDay = 3\nriskTradeUsd = 5`;
    const after = `maxTradesDay = 3\nriskTradeUsd = 10`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toEqual([]);
  });

  it("detects protected field change", () => {
    const before = `maxTradesDay = 3`;
    const after = `maxTradesDay = 5`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("maxTradesDay");
  });

  it("detects riskTradeUsd exceeding cap", () => {
    const before = `riskTradeUsd = 5`;
    const after = `riskTradeUsd = 30`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("riskTradeUsd");
  });

  it("detects atrMult exceeding maxAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, maxAtrMult: 8 };
    const before = `atrMult = 4.0`;
    const after = `atrMult = 9.0`;
    const v = validateGuardrails(before, after, guardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("atrMult");
  });

  it("detects atrMult below minAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, minAtrMult: 1.5 };
    const before = `atrMult = 3.0`;
    const after = `atrMult = 0.8`;
    const v = validateGuardrails(before, after, guardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("atrMult");
  });
});

describe("extractStrategyCategory", () => {
  it("extracts category from standard title", () => {
    expect(extractStrategyCategory(`strategy("BTC 15m Breakout — Donchian ADX")`)).toBe("breakout");
  });

  it("extracts multi-word category", () => {
    expect(extractStrategyCategory(`strategy("BTC 15m Mean Reversion — Keltner RSI2")`)).toBe("mean reversion");
  });

  it("returns null for no strategy() call", () => {
    expect(extractStrategyCategory(`indicator("My Indicator")`)).toBeNull();
  });

  it("returns null for title without em-dash", () => {
    expect(extractStrategyCategory(`strategy("Simple Strategy")`)).toBeNull();
  });
});

describe("countDayOfWeekUsage", () => {
  it("counts dayofweek occurrences", () => {
    expect(countDayOfWeekUsage("d = dayofweek(time, tz)")).toBe(1);
    expect(countDayOfWeekUsage("dayofweek == dayofweek.monday")).toBe(2);
    expect(countDayOfWeekUsage("no match here")).toBe(0);
  });

  it("is case insensitive", () => {
    expect(countDayOfWeekUsage("DAYOFWEEK DayOfWeek dayofweek")).toBe(3);
  });
});
