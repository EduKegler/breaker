import { describe, it, expect } from "vitest";
import { validateGuardrails, countDayOfWeekUsage, extractStrategyCategory } from "./guardrails.js";
import type { Guardrails } from "../../types/config.js";

const defaultGuardrails: Guardrails = {
  maxRiskTradeUsd: 25,
  protectedFields: ["commission_value", "initial_capital"],
};

describe("validateGuardrails", () => {
  it("returns empty when no violations", () => {
    const before = `commission_value = 0.06\ninitial_capital = 1000\nriskTradeUsd = 5`;
    const after = `commission_value = 0.06\ninitial_capital = 1000\nriskTradeUsd = 10`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toEqual([]);
  });

  it("detects protected field change", () => {
    const before = `commission_value = 0.06\ninitial_capital = 1000`;
    const after = `commission_value = 0.10\ninitial_capital = 1000`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("commission_value");
    expect(v[0].reason).toContain("Protected field changed");
  });

  it("detects riskTradeUsd exceeding cap", () => {
    const before = `riskTradeUsd = 5`;
    const after = `riskTradeUsd = 30`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("riskTradeUsd");
    expect(v[0].reason).toContain("Exceeds max");
  });

  it("detects strategy.exit count decrease", () => {
    const before = `strategy.exit("a")\nstrategy.exit("b")\nstrategy.exit("c")`;
    const after = `strategy.exit("a")`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("strategy.exit");
    expect(v[0].reason).toContain("decreased");
  });

  it("allows strategy.exit count increase", () => {
    const before = `strategy.exit("a")`;
    const after = `strategy.exit("a")\nstrategy.exit("b")`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toEqual([]);
  });

  it("handles multiple violations", () => {
    const before = `commission_value = 0.06\ninitial_capital = 1000\nriskTradeUsd = 5\nstrategy.exit("a")\nstrategy.exit("b")`;
    const after = `commission_value = 0.10\ninitial_capital = 2000\nriskTradeUsd = 50\nstrategy.exit("a")`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v.length).toBeGreaterThanOrEqual(4);
  });

  it("ignores fields not present in code", () => {
    const before = `atrMult = 4.0`;
    const after = `atrMult = 5.0`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toEqual([]);
  });

  it("detects atrMult exceeding maxAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, maxAtrMult: 8 };
    const before = `atrMult = 4.0`;
    const after = `atrMult = 9.0`;
    const v = validateGuardrails(before, after, guardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("atrMult");
    expect(v[0].reason).toContain("Exceeds max");
  });

  it("allows atrMult within maxAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, maxAtrMult: 8 };
    const before = `atrMult = 4.0`;
    const after = `atrMult = 7.5`;
    const v = validateGuardrails(before, after, guardrails);
    expect(v).toEqual([]);
  });

  it("does NOT count strategy.exit inside comments", () => {
    const before = `strategy.exit("a")\nstrategy.exit("b")`;
    const after = `strategy.exit("a")\n// strategy.exit("b")`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("strategy.exit");
    expect(v[0].reason).toContain("decreased");
  });

  it("counts only active strategy.exit lines, ignoring comments", () => {
    const before = `strategy.exit("a")\n// strategy.exit("b")\nstrategy.exit("c")`;
    const after = `strategy.exit("a")\nstrategy.exit("c")`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    // before has 2 active exits (a, c), after has 2 active exits → no violation
    expect(v).toEqual([]);
  });

  it("detects atrMult below minAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, minAtrMult: 1.5 };
    const before = `atrMult = 3.0`;
    const after = `atrMult = 0.8`;
    const v = validateGuardrails(before, after, guardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("atrMult");
    expect(v[0].reason).toContain("Below min");
  });

  it("allows atrMult above minAtrMult", () => {
    const guardrails: Guardrails = { ...defaultGuardrails, minAtrMult: 1.5 };
    const before = `atrMult = 3.0`;
    const after = `atrMult = 2.0`;
    const v = validateGuardrails(before, after, guardrails);
    expect(v).toEqual([]);
  });

  it("ignores protected field values in comments", () => {
    const before = `// old: commission_value = 0.03\ncommission_value = 0.06`;
    const after = `// old: commission_value = 0.03\ncommission_value = 0.06`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toEqual([]);
  });

  it("detects actual protected field change even when commented value exists", () => {
    const before = `// old: commission_value = 0.03\ncommission_value = 0.06`;
    const after = `// old: commission_value = 0.03\ncommission_value = 0.10`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("commission_value");
  });

  it("ignores riskTradeUsd values in comments", () => {
    const before = `// riskTradeUsd = 50\nriskTradeUsd = 10`;
    const after = `// riskTradeUsd = 50\nriskTradeUsd = 15`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v).toEqual([]);
  });

  it("detects dayofweek usage increase", () => {
    const before = `d = dayofweek(time, tz)\nstrategy.entry("long")`;
    const after = `d = dayofweek(time, tz)\nbadDay = dayofweek == dayofweek.monday\nstrategy.entry("long")`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "dayofweek")).toBe(true);
    expect(v.find((vi) => vi.field === "dayofweek")?.reason).toContain("increased");
  });

  it("allows same dayofweek count", () => {
    const before = `d = dayofweek(time, tz)\nstrategy.entry("long")`;
    const after = `d = dayofweek(time, tz)\nstrategy.entry("short")`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "dayofweek")).toBe(false);
  });

  it("allows dayofweek count decrease", () => {
    const before = `d = dayofweek(time, tz)\nbadDay = dayofweek == dayofweek.monday`;
    const after = `d = dayofweek(time, tz)`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "dayofweek")).toBe(false);
  });

  it("ignores dayofweek in comments for guardrail check", () => {
    const before = `d = dayofweek(time, tz)`;
    const after = `d = dayofweek(time, tz)\n// badDay = dayofweek == dayofweek.monday`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    // Comment lines are stripped, so the commented dayofweek should not increase count
    expect(v.some((vi) => vi.field === "dayofweek")).toBe(false);
  });

  it("detects strategy category change", () => {
    const before = `strategy("BTC 15m Breakout — Donchian ADX", overlay=true)`;
    const after = `strategy("BTC 15m Momentum — RSI Crossover", overlay=true)`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "strategy()")).toBe(true);
    expect(v.find((vi) => vi.field === "strategy()")?.reason).toContain("category changed");
  });

  it("allows same category with different strategy name", () => {
    const before = `strategy("BTC 15m Breakout — Donchian ADX", overlay=true)`;
    const after = `strategy("BTC 15m Breakout — Bollinger Squeeze", overlay=true)`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "strategy()")).toBe(false);
  });

  it("allows no strategy title in code (no false positive)", () => {
    const before = `riskTradeUsd = 10`;
    const after = `riskTradeUsd = 10`;
    const v = validateGuardrails(before, after, defaultGuardrails);
    expect(v.some((vi) => vi.field === "strategy()")).toBe(false);
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
