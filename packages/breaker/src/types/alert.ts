import { z } from "zod";

export const AlertPayloadSchema = z.object({
  alert_id: z.string().min(1),
  event_type: z.enum(["ENTRY"]),
  asset: z.string().min(1),
  side: z.enum(["LONG", "SHORT"]),
  entry: z.number().positive(),
  sl: z.number(),
  tp1: z.number().optional(),
  tp2: z.number().optional(),
  tp1_pct: z.number().min(0).max(100).optional(),
  qty: z.number().positive(),
  leverage: z.number().positive().optional(),
  risk_usd: z.number().optional(),
  notional_usdc: z.number().optional(),
  margin_usdc: z.number().optional(),
  signal_ts: z.number().optional(),
  bar_ts: z.number().optional(),
});

export type AlertPayload = z.infer<typeof AlertPayloadSchema>;
