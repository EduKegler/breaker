import { z } from "zod";

export const GuardrailsSchema = z.object({
  maxNotionalUsd: z.number().positive(),
  maxLeverage: z.number().int().positive(),
  maxOpenPositions: z.number().int().positive(),
  maxDailyLossR: z.number().positive(),
  // nonnegative allows 0 as a kill switch (blocks all trades)
  maxTradesPerDay: z.number().int().nonnegative(),
  cooldownBars: z.number().int().nonnegative(),
  volSpikeThresholdPct: z.number().positive().default(1.5),
  volSpikeLookbackBars: z.number().int().positive().default(4),
  volSpikeCooldownBars: z.number().int().positive().default(4),
});

export const SizingSchema = z.object({
  mode: z.enum(["risk", "cash"]),
  riskPerTradeUsd: z.number().positive(),
  cashPerTrade: z.number().positive(),
});

export const ModuleTypeEnum = z.enum(["breakout", "mean-reversion", "pullback", "trend-following"]);

/** Per-strategy overrides applied to auto-discovered strategies. */
export const StrategyOverrideSchema = z.object({
  autoTradingEnabled: z.boolean().optional(),
});

export const CoinConfigSchema = z.object({
  coin: z.string().min(1),
  leverage: z.number().int().positive(),
});

export const ExchangeConfigSchema = z.object({
  mode: z.enum(["testnet", "mainnet"]),
  port: z.number().int().positive().default(3200),
  gatewayUrl: z.string().url().default("http://localhost:3100"),
  coins: z.array(CoinConfigSchema).min(1),
  /** Per-strategy overrides applied to auto-discovered strategies. */
  strategyOverrides: z.record(StrategyOverrideSchema).default({}),
  dataSource: z.enum(["binance", "hyperliquid"]).default("binance"),
  marginType: z.enum(["isolated", "cross"]).default("isolated"),
  guardrails: GuardrailsSchema,
  sizing: SizingSchema,
  entrySlippageBps: z.number().int().nonnegative().default(50),
  dryRun: z.boolean().default(false),
  logLevels: z.record(z.string()).default({}),
});

export type Guardrails = z.infer<typeof GuardrailsSchema>;
export type Sizing = z.infer<typeof SizingSchema>;
export type StrategyOverride = z.infer<typeof StrategyOverrideSchema>;
export type CoinConfig = z.infer<typeof CoinConfigSchema>;
export type ExchangeConfig = z.infer<typeof ExchangeConfigSchema>;
export type ModuleType = z.infer<typeof ModuleTypeEnum>;
