import { z } from "zod";
import { parseEnv } from "@breaker/kit";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3100),
  EVOLUTION_API_URL: z.string().default("http://localhost:8080"),
  EVOLUTION_API_KEY: z.string().default(""),
  EVOLUTION_INSTANCE: z.string().default("sexta-feira"),
  WHATSAPP_RECIPIENT: z.string().default(""),
});

export type Env = z.infer<typeof EnvSchema>;
export const env = parseEnv(EnvSchema);
