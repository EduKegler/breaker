import { describe, it, expect } from "vitest";
import {
  BreakerConfigSchema,
  CriteriaSchema,
  StrategyProfileSchema,
  StrategyEntrySchema,
  GuardrailsSchema,
  PhasesConfigSchema,
  ScoringWeightsSchema,
  AssetConfigSchema,
  ResearchConfigSchema,
  DateRangeSchema,
} from "./config.js";

describe("BreakerConfigSchema", () => {
  it("accepts valid complete config", () => {
    const result = BreakerConfigSchema.safeParse({
      criteria: { minPF: 1.5, maxDD: 25, minTrades: 50, minWR: 50, minAvgR: 1.0 },
      rollbackThreshold: 0.15,
      modelRouting: {
        optimize: "claude-sonnet-4-6",
        fix: "claude-haiku-4-5-20251001",
        plan: "claude-opus-4-6",
      },
      assetClasses: {
        crypto: { minPF: 1.3, maxDD: 30 },
      },
      guardrails: { maxRiskTradeUsd: 25, protectedFields: ["entry"] },
      assets: {
        BTC: { class: "crypto" },
      },
      phases: { refine: { maxIter: 5 }, research: { maxIter: 3 }, restructure: { maxIter: 5 }, maxCycles: 2 },
      scoring: { weights: { pf: 25, avgR: 20, wr: 10, dd: 15, complexity: 10, sampleConfidence: 20 } },
      research: { enabled: true, model: "claude-sonnet-4-6", maxSearchesPerIter: 3, timeoutMs: 180000 },
    });
    expect(result.success).toBe(true);
  });

  it("applies all defaults on empty {} input", () => {
    const result = BreakerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data;
    expect(data.rollbackThreshold).toBeUndefined();
    expect(data.modelRouting.optimize).toBe("claude-sonnet-4-6");
    expect(data.guardrails.maxRiskTradeUsd).toBe(25);
    expect(data.guardrails.globalMaxTradesDay).toBe(5);
    expect(data.phases.refine.maxIter).toBe(5);
    expect(data.scoring.weights.pf).toBe(25);
    expect(data.research.enabled).toBe(true);
    expect(data.dateRange).toBe("last365");
  });

  it("rejects modelRouting with empty strings", () => {
    const result = BreakerConfigSchema.safeParse({
      modelRouting: { optimize: "", fix: "x", plan: "y" },
    });
    expect(result.success).toBe(false);
  });

  it("superRefine detects dangling class reference", () => {
    const result = BreakerConfigSchema.safeParse({
      assetClasses: {},
      assets: {
        BTC: { class: "crypto" },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const classIssue = result.error.issues.find((i) =>
      i.message.includes('references class "crypto"'),
    );
    expect(classIssue).toBeDefined();
  });
});

describe("DateRangeSchema", () => {
  it("accepts preset values", () => {
    for (const v of ["last7", "last30", "last90", "last365", "all"]) {
      expect(DateRangeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("accepts custom:YYYY-MM-DD:YYYY-MM-DD", () => {
    expect(DateRangeSchema.safeParse("custom:2025-08-01:2026-02-01").success).toBe(true);
  });

  it("rejects invalid preset", () => {
    expect(DateRangeSchema.safeParse("last60").success).toBe(false);
  });

  it("rejects custom with missing end date", () => {
    expect(DateRangeSchema.safeParse("custom:2025-08-01").success).toBe(false);
  });

  it("rejects custom with bad date format", () => {
    expect(DateRangeSchema.safeParse("custom:2025-8-1:2026-2-1").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(DateRangeSchema.safeParse("").success).toBe(false);
  });
});

describe("CriteriaSchema", () => {
  it("applies defaults for optional fields", () => {
    const result = CriteriaSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    // All fields are optional so they should be undefined
    expect(result.data.minPF).toBeUndefined();
    expect(result.data.maxDD).toBeUndefined();
    expect(result.data.minTrades).toBeUndefined();
    expect(result.data.minTradesForFilter).toBeUndefined();
  });
});

describe("GuardrailsSchema", () => {
  it("rejects negative maxRiskTradeUsd", () => {
    const result = GuardrailsSchema.safeParse({
      maxRiskTradeUsd: -1,
      protectedFields: [],
    });
    expect(result.success).toBe(false);
  });

  it("defaults globalMaxTradesDay to 5", () => {
    const result = GuardrailsSchema.safeParse({
      maxRiskTradeUsd: 25,
      protectedFields: [],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.globalMaxTradesDay).toBe(5);
  });

  it("accepts custom globalMaxTradesDay", () => {
    const result = GuardrailsSchema.safeParse({
      maxRiskTradeUsd: 25,
      globalMaxTradesDay: 3,
      protectedFields: [],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.globalMaxTradesDay).toBe(3);
  });

  it("rejects globalMaxTradesDay < 1", () => {
    const result = GuardrailsSchema.safeParse({
      maxRiskTradeUsd: 25,
      globalMaxTradesDay: 0,
      protectedFields: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("PhasesConfigSchema", () => {
  it("applies maxIter defaults", () => {
    const result = PhasesConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.refine.maxIter).toBe(5);
    expect(result.data.research.maxIter).toBe(3);
    expect(result.data.restructure.maxIter).toBe(5);
    expect(result.data.maxCycles).toBe(2);
  });
});

describe("ScoringWeightsSchema", () => {
  it("applies default weights", () => {
    const result = ScoringWeightsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pf).toBe(25);
    expect(result.data.avgR).toBe(20);
    expect(result.data.wr).toBe(10);
    expect(result.data.dd).toBe(15);
    expect(result.data.complexity).toBe(10);
    expect(result.data.sampleConfidence).toBe(20);
  });
});

describe("StrategyEntrySchema", () => {
  it("accepts empty entry", () => {
    const result = StrategyEntrySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts entry with optional profile", () => {
    const result = StrategyEntrySchema.safeParse({
      profile: "mean-reversion",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.profile).toBe("mean-reversion");
  });

  it("accepts entry with optional dateRange", () => {
    const result = StrategyEntrySchema.safeParse({
      dateRange: "custom:2025-08-01:2026-02-01",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.dateRange).toBe("custom:2025-08-01:2026-02-01");
  });

  it("rejects entry with invalid dateRange", () => {
    const result = StrategyEntrySchema.safeParse({
      dateRange: "last60",
    });
    expect(result.success).toBe(false);
  });
});

describe("AssetConfigSchema", () => {
  it("accepts class-only config (all other fields optional)", () => {
    const result = AssetConfigSchema.safeParse({ class: "crypto" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.strategies).toEqual({});
    expect(result.data.strategy).toBeUndefined();
  });

  it("accepts config with nested strategies", () => {
    const result = AssetConfigSchema.safeParse({
      class: "crypto",
      strategies: {
        breakout: {},
      },
    });
    expect(result.success).toBe(true);
  });

});

describe("ResearchConfigSchema", () => {
  it("rejects timeoutMs < 10000", () => {
    const result = ResearchConfigSchema.safeParse({ timeoutMs: 5000 });
    expect(result.success).toBe(false);
  });
});

describe("StrategyProfileSchema", () => {
  it("accepts empty profile (inherits all from class)", () => {
    const result = StrategyProfileSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts profile with criteria overrides and limits", () => {
    const result = StrategyProfileSchema.safeParse({
      minPF: 1.3, maxDD: 8, minWR: 50, minTrades: 80,
      maxIterations: 15, maxFreeVariables: 5,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.minPF).toBe(1.3);
    expect(result.data.maxIterations).toBe(15);
    expect(result.data.maxFreeVariables).toBe(5);
  });

  it("rejects maxFreeVariables < 1", () => {
    const result = StrategyProfileSchema.safeParse({ maxFreeVariables: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects maxIterations < 1", () => {
    const result = StrategyProfileSchema.safeParse({ maxIterations: 0 });
    expect(result.success).toBe(false);
  });
});

describe("BreakerConfigSchema — strategyProfiles", () => {
  it("accepts config with strategyProfiles and strategy references", () => {
    const result = BreakerConfigSchema.safeParse({
      strategyProfiles: { breakout: {}, "mean-reversion": { minPF: 1.3 } },
      assetClasses: { "crypto-major": {} },
      assets: {
        BTC: { class: "crypto-major", strategy: "breakout" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("defaults strategyProfiles to empty object", () => {
    const result = BreakerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.strategyProfiles).toEqual({});
  });

  it("rejects asset referencing undefined strategy profile", () => {
    const result = BreakerConfigSchema.safeParse({
      strategyProfiles: {},
      assetClasses: { "crypto-major": {} },
      assets: {
        BTC: { class: "crypto-major", strategy: "nonexistent" },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) =>
      i.message.includes('references strategy "nonexistent"'),
    );
    expect(issue).toBeDefined();
  });

  it("accepts asset without strategy field", () => {
    const result = BreakerConfigSchema.safeParse({
      assetClasses: { "crypto-major": {} },
      assets: {
        BTC: { class: "crypto-major" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects nested strategy referencing undefined profile", () => {
    const result = BreakerConfigSchema.safeParse({
      strategyProfiles: {},
      assetClasses: { "crypto-major": {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: { profile: "nonexistent-profile" },
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) =>
      i.message.includes('references profile "nonexistent-profile"'),
    );
    expect(issue).toBeDefined();
  });

  it("rejects nested strategy with implicit profile not in strategyProfiles", () => {
    const result = BreakerConfigSchema.safeParse({
      strategyProfiles: {},
      assetClasses: { "crypto-major": {} },
      assets: {
        BTC: {
          class: "crypto-major",
          strategies: {
            breakout: {},
          },
        },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // When no profile field, defaults to strategy name "breakout"
    const issue = result.error.issues.find((i) =>
      i.message.includes('references profile "breakout"'),
    );
    expect(issue).toBeDefined();
  });
});
