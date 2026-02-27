import { z } from "zod";

export const GuardrailsSchema = z.object({
  maxNotionalUsd: z.number().positive(),
  maxLeverage: z.number().int().positive(),
  maxOpenPositions: z.number().int().positive(),
  maxDailyLossUsd: z.number().positive(),
  // nonnegative allows 0 as a kill switch (blocks all trades)
  maxTradesPerDay: z.number().int().nonnegative(),
  cooldownBars: z.number().int().nonnegative(),
});

export const SizingSchema = z.object({
  mode: z.enum(["risk", "cash"]),
  riskPerTradeUsd: z.number().positive(),
  cashPerTrade: z.number().positive(),
});

export const ExchangeConfigSchema = z.object({
  mode: z.enum(["testnet", "live"]),
  port: z.number().int().positive().default(3200),
  gatewayUrl: z.string().url().default("http://localhost:3100"),
  asset: z.string().min(1),
  strategy: z.enum(["donchian-adx", "keltner-rsi2"]),
  interval: z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"]),
  dataSource: z.enum(["binance", "hyperliquid"]).default("binance"),
  warmupBars: z.number().int().positive().default(200),
  leverage: z.number().int().positive(),
  marginType: z.enum(["isolated", "cross"]).default("isolated"),
  guardrails: GuardrailsSchema,
  sizing: SizingSchema,
  dryRun: z.boolean().default(false),
  logLevels: z.record(z.string()).default({}),
});

export type Guardrails = z.infer<typeof GuardrailsSchema>;
export type Sizing = z.infer<typeof SizingSchema>;
export type ExchangeConfig = z.infer<typeof ExchangeConfigSchema>;
