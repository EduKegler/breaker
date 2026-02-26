import dotenv from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseEnv } from "@breaker/kit";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "../../infra/.env") });

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  WEBHOOK_SECRET: z.string().default(""),
  GATEWAY_URL: z.string().default("http://localhost:3100"),
  TTL_SECONDS: z.coerce.number().default(1200),
  REDIS_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export const env = parseEnv(EnvSchema);
