import { z } from "zod";
import { parseEnv } from "@breaker/kit";
import dotenv from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EnvSchema = z.object({
  HL_ACCOUNT_ADDRESS: z.string().min(1),
  HL_PRIVATE_KEY: z.string().min(1),
});

type Env = z.infer<typeof EnvSchema>;

/**
 * Load .env file based on mode and return parsed env.
 * Uses .env.testnet or .env.mainnet in the package root.
 */
export function loadEnv(mode: "testnet" | "mainnet"): Env {
  const suffix = mode === "testnet" ? "testnet" : "mainnet";
  const envPath = join(__dirname, `../../.env.${suffix}`);
  dotenv.config({ path: envPath });
  return parseEnv(EnvSchema);
}
