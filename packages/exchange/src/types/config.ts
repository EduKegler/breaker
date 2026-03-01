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

export const CoinStrategySchema = z.object({
  name: z.enum(["donchian-adx", "keltner-rsi2", "ema-pullback"]),
  interval: z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"]),
  warmupBars: z.number().int().positive().default(200),
  autoTradingEnabled: z.boolean().default(false),
});

export const CoinConfigSchema = z.object({
  coin: z.string().min(1),
  leverage: z.number().int().positive(),
  strategies: z.array(CoinStrategySchema).min(1),
});

export const ExchangeConfigSchema = z.object({
  mode: z.enum(["testnet", "mainnet"]),
  port: z.number().int().positive().default(3200),
  gatewayUrl: z.string().url().default("http://localhost:3100"),
  coins: z.array(CoinConfigSchema).min(1),
  dataSource: z.enum(["binance", "hyperliquid"]).default("binance"),
  marginType: z.enum(["isolated", "cross"]).default("isolated"),
  guardrails: GuardrailsSchema,
  sizing: SizingSchema,
  entrySlippageBps: z.number().int().nonnegative().default(10),
  dryRun: z.boolean().default(false),
  logLevels: z.record(z.string()).default({}),
});

export type Guardrails = z.infer<typeof GuardrailsSchema>;
export type Sizing = z.infer<typeof SizingSchema>;
export type CoinStrategy = z.infer<typeof CoinStrategySchema>;
export type CoinConfig = z.infer<typeof CoinConfigSchema>;
export type ExchangeConfig = z.infer<typeof ExchangeConfigSchema>;
