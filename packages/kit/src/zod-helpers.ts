import type { z } from "zod";

export function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const prefix = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
    return `${prefix}${i.message}`;
  });
}
