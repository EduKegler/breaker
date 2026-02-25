import { z } from "zod";

// --- Zod Schemas ---

export const DateRangeSchema = z.string().regex(
  /^(last7|last30|last90|last365|all|custom:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2})$/,
  "Must be last7|last30|last90|last365|all|custom:YYYY-MM-DD:YYYY-MM-DD",
);

export const AssetClassCriteriaSchema = z.object({
  minPF: z.number().min(0).optional(),
  maxDD: z.number().min(0).max(100).optional(),
  minTrades: z.number().int().min(0).optional(),
  minWR: z.number().min(0).max(100).optional(),
  minAvgR: z.number().optional(),
});

export const CriteriaSchema = AssetClassCriteriaSchema.extend({
  minTradesForFilter: z.number().int().min(0).optional(),
});

export const CoreParameterDefSchema = z.object({
  name: z.string().min(1),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
});

export const StrategyProfileSchema = AssetClassCriteriaSchema.extend({
  maxIterations: z.number().int().min(1).optional(),
  maxFreeVariables: z.number().int().min(1).optional(),
  coreParameters: z.array(CoreParameterDefSchema).optional(),
  designChecklist: z.array(z.string()).optional(),
});

export const ModelRoutingSchema = z.object({
  optimize: z.string().min(1),
  restructure: z.string().min(1).optional(),
  fix: z.string().min(1),
  plan: z.string().min(1),
});

export const GuardrailsSchema = z.object({
  maxRiskTradeUsd: z.number().min(0),
  maxAtrMult: z.number().min(1).default(10),
  minAtrMult: z.number().min(0).default(1.5),
  protectedFields: z.array(z.string()),
});

export const StrategyEntrySchema = z.object({
  chartUrl: z.string().url(),
  profile: z.string().optional(),
  dateRange: DateRangeSchema.optional(),
});

export const AssetConfigSchema = z.object({
  class: z.string().min(1),
  strategies: z.record(z.string(), StrategyEntrySchema).default({}),
  // Legacy flat fields (kept for backwards compat during migration)
  chartUrl: z.string().url().optional(),
  strategy: z.string().optional(),
});

export const PhasesConfigSchema = z.object({
  refine: z.object({ maxIter: z.number().int().min(1).default(5) }).default({}),
  research: z.object({ maxIter: z.number().int().min(1).default(3) }).default({}),
  restructure: z.object({ maxIter: z.number().int().min(1).default(5) }).default({}),
  maxCycles: z.number().int().min(1).default(2),
});

export const ScoringWeightsSchema = z.object({
  pf: z.number().min(0).default(25),
  avgR: z.number().min(0).default(20),
  wr: z.number().min(0).default(10),
  dd: z.number().min(0).default(15),
  complexity: z.number().min(0).default(10),
  sampleConfidence: z.number().min(0).default(20),
});

export const ScoringConfigSchema = z.object({
  weights: ScoringWeightsSchema.default({}),
});

export const ResearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default("claude-sonnet-4-6"),
  maxSearchesPerIter: z.number().int().min(1).default(3),
  timeoutMs: z.number().int().min(10000).default(180000),
  allowedDomains: z.array(z.string()).default([]),
});

export const BreakerConfigSchema = z
  .object({
    criteria: CriteriaSchema.default({}),
    dateRange: DateRangeSchema.default("last365"),
    rollbackThreshold: z.number().min(0).max(1).optional(), // legacy: unused, rollback uses score-based compareScores()
    modelRouting: ModelRoutingSchema.default({
      optimize: "claude-sonnet-4-6",
      fix: "claude-haiku-4-5-20251001",
      plan: "claude-opus-4-6",
    }),
    assetClasses: z
      .record(z.string(), AssetClassCriteriaSchema)
      .default({}),
    strategyProfiles: z
      .record(z.string(), StrategyProfileSchema)
      .default({}),
    guardrails: GuardrailsSchema.default({
      maxRiskTradeUsd: 25,
      maxAtrMult: 10,
      protectedFields: [],
    }),
    assets: z.record(z.string(), AssetConfigSchema).default({}),
    phases: PhasesConfigSchema.default({}),
    scoring: ScoringConfigSchema.default({}),
    research: ResearchConfigSchema.default({}),
  })
  .superRefine((data, ctx) => {
    for (const [asset, cfg] of Object.entries(data.assets)) {
      if (cfg.class && !(cfg.class in data.assetClasses)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Asset "${asset}" references class "${cfg.class}" which is not defined in assetClasses`,
          path: ["assets", asset, "class"],
        });
      }
      // Legacy flat strategy field
      if (cfg.strategy && !(cfg.strategy in data.strategyProfiles)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Asset "${asset}" references strategy "${cfg.strategy}" which is not defined in strategyProfiles`,
          path: ["assets", asset, "strategy"],
        });
      }
      // Nested strategies: validate profile references
      for (const [stratName, stratEntry] of Object.entries(cfg.strategies)) {
        const profileName = stratEntry.profile ?? stratName;
        if (profileName && !(profileName in data.strategyProfiles)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Asset "${asset}" strategy "${stratName}" references profile "${profileName}" which is not defined in strategyProfiles`,
            path: ["assets", asset, "strategies", stratName, "profile"],
          });
        }
      }
    }
  });

// --- TypeScript types (inferred from Zod) ---

export type AssetClassCriteria = z.infer<typeof AssetClassCriteriaSchema>;
export type Criteria = z.infer<typeof CriteriaSchema>;
export type StrategyProfile = z.infer<typeof StrategyProfileSchema>;
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;
export type Guardrails = z.infer<typeof GuardrailsSchema>;
export type StrategyEntry = z.infer<typeof StrategyEntrySchema>;
export type AssetConfig = z.infer<typeof AssetConfigSchema>;
export type PhasesConfig = z.infer<typeof PhasesConfigSchema>;
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;
export type BreakerConfig = z.infer<typeof BreakerConfigSchema>;
export type CoreParameterDef = z.infer<typeof CoreParameterDefSchema>;
export type ResolvedCriteria = Criteria & {
  maxFreeVariables?: number;
  maxIterations?: number;
  coreParameters?: CoreParameterDef[];
  designChecklist?: string[];
};
