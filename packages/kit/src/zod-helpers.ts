import type { z } from "zod";

export function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}
