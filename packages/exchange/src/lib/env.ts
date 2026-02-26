import { z } from "zod";
import { parseEnv } from "@breaker/kit";

const EnvSchema = z.object({
  HL_ACCOUNT_ADDRESS: z.string().min(1),
  HL_PRIVATE_KEY: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;
export const env = parseEnv(EnvSchema);
