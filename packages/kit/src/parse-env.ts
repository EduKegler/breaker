import type { z } from "zod";

export function parseEnv<T extends z.ZodTypeAny>(schema: T): z.output<T> {
  return schema.parse(process.env);
}
