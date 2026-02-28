import type { ErrorClass } from "./types.js";

const ERROR_PATTERNS: [RegExp, ErrorClass][] = [
  [/compilat|syntax|type.*error|tsc|typecheck/i, "compile_error"],
  [/timeout|timed out|ETIMEDOUT/i, "timeout"],
  [/net::|ECONNREFUSED|ECONNRESET|ERR_NAME_NOT_RESOLVED|fetch failed/i, "network"],
  [/ENOENT|spawn.*failed|child.*process/i, "transient"],
];

/**
 * Classifies an error message into a known category.
 * Used to decide retry strategy and error budget deduction.
 */
export function classifyError(message: string): ErrorClass {
  for (const [pattern, errorClass] of ERROR_PATTERNS) {
    if (pattern.test(message)) return errorClass;
  }
  return "unknown";
}
