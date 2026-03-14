import { describe, it, expect } from "vitest";
import { validateGuardrails, validateParamGuardrails, validateWalkForward, validateRollingWalkForward, validateArchetypeWR, validateFreeVariableCount, validateDiagnosticTracking, validateStrategyStructure, validateProfitabilityRegression } from "./guardrails.js";
import type { Guardrails } from "../../types/config.js";
import type { StrategyParam, WalkForward, RollingWalkForward } from "@breaker/backtest";

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
    const guardrails: Guardrails = { ...defaultGuardrails, minAtrMult: 2.5 };
    const before = { atrStopMult: mkParam(3, 0.5, 10) };
    const after = { atrStopMult: mkParam(2.0, 0.5, 10) };
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
    const guardrails: Guardrails = { ...defaultGuardrails, minAtrMult: 2.5 };
    const before = `atrMult = 3.0`;
    const after = `atrMult = 2.0`;
    const v = validateGuardrails(before, after, guardrails);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("atrMult");
  });
});

function mkWalkForward(overrides: Partial<WalkForward> = {}): WalkForward {
  return {
    trainTrades: 70,
    testTrades: 30,
    splitRatio: 0.7,
    hourConsistency: [],
    trainPF: 2.0,
    testPF: 1.5,
    pfRatio: 0.75,
    overfitFlag: false,
    ...overrides,
  };
}

describe("validateWalkForward", () => {
  it("returns empty when walk-forward is null (not enough trades)", () => {
    expect(validateWalkForward(null)).toEqual([]);
  });

  it("returns empty when overfitFlag is false", () => {
    expect(validateWalkForward(mkWalkForward())).toEqual([]);
  });

  it("detects overfitFlag true (pfRatio < 0.5)", () => {
    const wf = mkWalkForward({ overfitFlag: true, pfRatio: 0.4, testPF: 0.8 });
    const v = validateWalkForward(wf);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("overfitFlag");
    expect(v[0].reason).toContain("pfRatio=0.40");
  });

  it("does not flag when testPF < 1.0 but pfRatio >= 0.6 (not overfit, just bad)", () => {
    // overfitFlag is now only set when pfRatio < 0.6, so this should not trigger
    const wf = mkWalkForward({ overfitFlag: false, pfRatio: 0.6, testPF: 0.9, trainPF: 1.5 });
    const v = validateWalkForward(wf);
    expect(v).toEqual([]);
  });

  it("includes trainPF in reason message", () => {
    const wf = mkWalkForward({ overfitFlag: true, trainPF: 0.95, pfRatio: 0.4, testPF: 0.8 });
    const v = validateWalkForward(wf);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("trainPF=0.95");
  });

  it("includes pfRatio N/A when null", () => {
    const wf = mkWalkForward({ overfitFlag: true, pfRatio: null, testPF: 0.5 });
    const v = validateWalkForward(wf);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("pfRatio=N/A");
  });
});

function mkRollingWalkForward(overrides: Partial<RollingWalkForward> = {}): RollingWalkForward {
  return {
    windows: [],
    windowsPassed: 2,
    windowsTotal: 3,
    passRate: 0.67,
    worstPfRatio: 0.65,
    overfitFlag: false,
    ...overrides,
  };
}

describe("validateRollingWalkForward", () => {
  it("returns empty when rolling WF is null", () => {
    expect(validateRollingWalkForward(null)).toEqual([]);
  });

  it("returns empty when overfitFlag is false", () => {
    expect(validateRollingWalkForward(mkRollingWalkForward())).toEqual([]);
  });

  it("detects overfitFlag true with window details in reason message", () => {
    const rwf = mkRollingWalkForward({
      overfitFlag: true,
      windowsPassed: 1,
      windowsTotal: 3,
      passRate: 0.33,
      windows: [
        { windowIndex: 0, trainTrades: 40, testTrades: 20, trainPF: 1.5, testPF: 1.2, pfRatio: 0.8, pass: true },
        { windowIndex: 1, trainTrades: 40, testTrades: 20, trainPF: 1.8, testPF: 0.6, pfRatio: 0.33, pass: false },
        { windowIndex: 2, trainTrades: 40, testTrades: 20, trainPF: 2.0, testPF: 0.5, pfRatio: 0.25, pass: false },
      ],
    });
    const v = validateRollingWalkForward(rwf);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("rollingWfOverfit");
    expect(v[0].reason).toContain("1/3 passed");
    expect(v[0].reason).toContain("33%");
    expect(v[0].reason).toContain("win1");
    expect(v[0].reason).toContain("win2");
    expect(v[0].reason).not.toContain("win0");
  });
});

describe("validateArchetypeWR", () => {
  it("returns no violations when WR within range", () => {
    expect(validateArchetypeWR(35, 55)).toEqual([]);
  });

  it("returns no violations when WR exactly at wrRejectMax", () => {
    expect(validateArchetypeWR(55, 55)).toEqual([]);
  });

  it("returns violation when WR above wrRejectMax", () => {
    const v = validateArchetypeWR(68.7, 55);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("archetypeWR");
    expect(v[0].reason).toContain("68.7%");
    expect(v[0].reason).toContain("55%");
  });

  it("skips check when wrRejectMax is null", () => {
    expect(validateArchetypeWR(99, null)).toEqual([]);
  });
});

describe("validateDiagnosticTracking", () => {
  it("returns empty when source contains ctx.track()", () => {
    const source = `
      const longBreakout = ctx.track('L:breakout', close > upper, close, upper);
      ctx.indicator('adx', adxVal);
    `;
    expect(validateDiagnosticTracking(source)).toEqual([]);
  });

  it("detects missing ctx.track() calls", () => {
    const source = `
      if (close > upper && adxVal < threshold) {
        return { direction: "long", entryPrice: upper };
      }
    `;
    const v = validateDiagnosticTracking(source);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("diagnostics");
    expect(v[0].reason).toContain("ctx.track()");
  });

  it("ignores commented-out ctx.track() calls", () => {
    const source = `
      // ctx.track('L:breakout', close > upper, close, upper);
      if (close > upper) return signal;
    `;
    const v = validateDiagnosticTracking(source);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("diagnostics");
  });
});

describe("validateFreeVariableCount", () => {
  it("returns empty when maxFreeVariables is undefined", () => {
    expect(validateFreeVariableCount(10, undefined)).toEqual([]);
  });

  it("returns empty when within limit", () => {
    expect(validateFreeVariableCount(6, 8)).toEqual([]);
  });

  it("returns empty when exactly at limit", () => {
    expect(validateFreeVariableCount(8, 8)).toEqual([]);
  });

  it("detects exceeding maxFreeVariables", () => {
    const v = validateFreeVariableCount(9, 8);
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("freeVariables");
    expect(v[0].reason).toContain("9 > 8");
  });
});

// --- Complete strategy source fixture for structural validation ---
const VALID_STRATEGY_SOURCE = `
const MS_1H = 3_600_000;

export function createMyStrategy(paramOverrides) {
  let atrCache = null;
  let htfCandlesRef = null;

  return {
    name: "BTC 15m Breakout — My Strategy",
    params,
    requiredTimeframes: ["1h"],
    requiredWarmup: { source: 22, "1h": 15 },

    init(candles, higherTimeframes) {
      htfCandlesRef = higherTimeframes["1h"] ?? [];
      atrCache = computeAtr(candles, 14);
    },

    onCandle(ctx) {
      const { candles, index, currentCandle, higherTimeframes } = ctx;
      if (index < 22) return null;

      // Anti-repaint HTF: only use completed bars
      let atr1h = NaN;
      for (let j = htfCandlesRef.length - 1; j >= 0; j--) {
        if (htfCandlesRef[j].t + MS_1H <= currentCandle.t && !isNaN(htfAtr[j])) {
          atr1h = htfAtr[j];
          break;
        }
      }
      if (isNaN(atr1h)) return null;

      ctx.indicator('close', currentCandle.c);
      ctx.indicator('atr1h', atr1h);

      const longBreakout = ctx.track('L:breakout', currentCandle.c > upper, currentCandle.c, upper);
      if (longBreakout) return { direction: "long", entryPrice: null, stopLoss: sl, takeProfits: [], comment: "breakout" };
      return null;
    },

    shouldExit(ctx) {
      const { index, positionDirection, positionEntryBarIndex } = ctx;
      if (!positionDirection || positionEntryBarIndex === null) return null;
      const barsInTrade = index - positionEntryBarIndex;
      if (barsInTrade >= params.timeoutBars.value) {
        return { exit: true, comment: "Timeout" };
      }
      return null;
    },

    computeLevels(ctx, direction) {
      const close = ctx.currentCandle.c;
      const stopDist = atr1h * params.atrStopMult.value;
      return {
        stopLoss: direction === "long" ? close - stopDist : close + stopDist,
        takeProfits: [],
      };
    },
  };
}
`;

describe("validateStrategyStructure", () => {
  it("returns empty for valid strategy with all required patterns", () => {
    expect(validateStrategyStructure(VALID_STRATEGY_SOURCE)).toEqual([]);
  });

  it("detects missing ctx.track()", () => {
    const source = VALID_STRATEGY_SOURCE.replace(/ctx\.track\(/g, "/* removed */");
    const v = validateStrategyStructure(source);
    expect(v.some((vi) => vi.field === "diagnostics")).toBe(true);
  });

  it("detects missing computeLevels", () => {
    const source = VALID_STRATEGY_SOURCE.replace(/computeLevels\(/g, "myOtherMethod(");
    const v = validateStrategyStructure(source);
    expect(v.some((vi) => vi.field === "computeLevels")).toBe(true);
  });

  it("detects missing shouldExit", () => {
    const source = VALID_STRATEGY_SOURCE.replace(/shouldExit\(/g, "someOtherExit(");
    const v = validateStrategyStructure(source);
    expect(v.some((vi) => vi.field === "shouldExit")).toBe(true);
  });

  it("detects missing requiredTimeframes", () => {
    const source = VALID_STRATEGY_SOURCE.replace(/requiredTimeframes/g, "myTimeframes");
    const v = validateStrategyStructure(source);
    expect(v.some((vi) => vi.field === "requiredTimeframes")).toBe(true);
  });

  it("detects missing anti-repaint HTF check", () => {
    // Remove the .t + MS_ pattern
    const source = VALID_STRATEGY_SOURCE.replace(/\.t \+ MS_1H/g, "/* no repaint check */");
    const v = validateStrategyStructure(source);
    expect(v.some((vi) => vi.field === "antiRepaint")).toBe(true);
  });

  it("detects multiple violations at once", () => {
    const source = `
      export function createBroken() {
        return {
          name: "Broken",
          params,
          onCandle(ctx) {
            if (ctx.currentCandle.c > 100) return { direction: "long" };
            return null;
          },
        };
      }
    `;
    const v = validateStrategyStructure(source);
    const fields = v.map((vi) => vi.field);
    expect(fields).toContain("diagnostics");
    expect(fields).toContain("computeLevels");
    expect(fields).toContain("shouldExit");
    expect(fields).toContain("requiredTimeframes");
    expect(fields).toContain("antiRepaint");
    expect(v).toHaveLength(5);
  });

  it("ignores commented-out patterns", () => {
    const source = `
      // computeLevels(ctx, direction) { ... }
      // shouldExit(ctx) { ... }
      // requiredTimeframes: ["1h"]
      // htfCandlesRef[j].t + MS_1H <= currentCandle.t
      // ctx.track('L:breakout', ...)
      export function createBroken() {
        return {
          name: "Broken",
          onCandle(ctx) { return null; },
        };
      }
    `;
    const v = validateStrategyStructure(source);
    expect(v).toHaveLength(5);
  });

  it("accepts mapHtfToSource helper as valid anti-repaint", () => {
    // Replace inline .t + MS_1H with a helper-based pattern
    const source = VALID_STRATEGY_SOURCE
      .replace(/\.t \+ MS_1H/g, "/* no inline check */")
      .replace("let atrCache = null;", "let atrCache = null;\n  function mapHtfToSource(htf, src) { return htf; }");
    expect(validateStrategyStructure(source).some((v) => v.field === "antiRepaint")).toBe(false);
  });

  it("rejects when neither inline nor mapHtfToSource exists", () => {
    const source = VALID_STRATEGY_SOURCE.replace(/\.t \+ MS_1H/g, "/* no repaint check */");
    expect(validateStrategyStructure(source).some((v) => v.field === "antiRepaint")).toBe(true);
  });

  it("accepts MS_4H and MS_1D as valid anti-repaint constants", () => {
    const with4h = VALID_STRATEGY_SOURCE.replace(/MS_1H/g, "MS_4H");
    expect(validateStrategyStructure(with4h).some((v) => v.field === "antiRepaint")).toBe(false);

    const with1d = VALID_STRATEGY_SOURCE.replace(/MS_1H/g, "MS_1D");
    expect(validateStrategyStructure(with1d).some((v) => v.field === "antiRepaint")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateProfitabilityRegression
// ---------------------------------------------------------------------------
describe("validateProfitabilityRegression", () => {
  it("returns empty when PF improved", () => {
    expect(validateProfitabilityRegression(
      { profitFactor: 1.5, avgR: -0.10 },
      { profitFactor: 1.2, avgR: -0.05 },
    )).toEqual([]);
  });

  it("returns empty when avgR improved", () => {
    expect(validateProfitabilityRegression(
      { profitFactor: 0.8, avgR: 0.10 },
      { profitFactor: 1.0, avgR: -0.10 },
    )).toEqual([]);
  });

  it("returns empty when both improved", () => {
    expect(validateProfitabilityRegression(
      { profitFactor: 1.5, avgR: 0.20 },
      { profitFactor: 1.2, avgR: 0.10 },
    )).toEqual([]);
  });

  it("returns empty when values equal (no regression)", () => {
    expect(validateProfitabilityRegression(
      { profitFactor: 1.0, avgR: 0.0 },
      { profitFactor: 1.0, avgR: 0.0 },
    )).toEqual([]);
  });

  it("detects regression when both PF AND avgR worsened", () => {
    const v = validateProfitabilityRegression(
      { profitFactor: 0.8, avgR: -0.30 },
      { profitFactor: 1.2, avgR: -0.10 },
    );
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("profitabilityRegression");
    expect(v[0].reason).toContain("PF");
    expect(v[0].reason).toContain("avgR");
  });

  it("handles null metrics (treats as 0)", () => {
    const v = validateProfitabilityRegression(
      { profitFactor: null, avgR: null },
      { profitFactor: 0.5, avgR: 0.1 },
    );
    expect(v).toHaveLength(1);
    expect(v[0].field).toBe("profitabilityRegression");
  });

  it("detects the iter-8 scenario: PF drops, avgR drops, trades increase", () => {
    // Real case: PF 0.49→0.41, avgR -0.20→-0.24 (trades 113→150 boosted score)
    const v = validateProfitabilityRegression(
      { profitFactor: 0.41, avgR: -0.24 },
      { profitFactor: 0.49, avgR: -0.20 },
    );
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("0.49");
    expect(v[0].reason).toContain("0.41");
    expect(v[0].reason).toContain("-0.200");
    expect(v[0].reason).toContain("-0.240");
  });

  it("NEUTRAL contamination: guard must use checkpoint baseline, not NEUTRAL metrics", () => {
    // Real bug: checkpoint PF=1.09, NEUTRAL iter PF=1.52 (not saved),
    // new iter PF=1.29. Guard with NEUTRAL baseline rejects (1.29 < 1.52).
    // Guard with checkpoint baseline should pass (1.29 > 1.09).
    const checkpointBaseline = { profitFactor: 1.09, avgR: 0.005 };
    const neutralBaseline = { profitFactor: 1.52, avgR: 0.020 };
    const newMetrics = { profitFactor: 1.29, avgR: 0.010 };

    // Bug: using NEUTRAL baseline → false rejection
    const bugResult = validateProfitabilityRegression(newMetrics, neutralBaseline);
    expect(bugResult).toHaveLength(1);
    expect(bugResult[0].field).toBe("profitabilityRegression");

    // Fix: using checkpoint baseline → correctly passes (PF improved 1.09→1.29)
    const fixResult = validateProfitabilityRegression(newMetrics, checkpointBaseline);
    expect(fixResult).toEqual([]);
  });
});
