import { jsonrepair } from "jsonrepair";
import { type ZodType } from "zod";

/**
 * Parse JSON with optional repair (for LLM output) and optional Zod validation.
 *
 * @param raw - The raw string to parse
 * @param opts.repair - If true, run jsonrepair before JSON.parse (use for Claude/LLM output)
 * @param opts.schema - Optional Zod schema to validate the parsed result
 * @returns The parsed (and optionally validated) value
 * @throws {SyntaxError} If JSON is invalid and repair is not enabled
 * @throws {ZodError} If schema validation fails
 */
export function safeJsonParse<T>(raw: string, opts?: { repair?: boolean; schema?: ZodType<T> }): T {
  const text = opts?.repair ? jsonrepair(raw) : raw;
  const parsed = JSON.parse(text);
  if (opts?.schema) {
    return opts.schema.parse(parsed);
  }
  return parsed as T;
}
