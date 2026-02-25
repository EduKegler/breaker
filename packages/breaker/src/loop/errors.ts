import type { ErrorClass } from "./types.js";

const ERROR_PATTERNS: [RegExp, ErrorClass][] = [
  [/compilat|syntax|erro.*compilacao|Script tem \d+ erro/i, "compile_error"],
  [/timeout|timed out|waitFor/i, "timeout"],
  [/net::|ECONNREFUSED|ECONNRESET|ERR_NAME_NOT_RESOLVED|fetch failed/i, "network"],
  [/stale|xlsx.*old|token.*not.*found|token.*not.*confirmed|nao.*confirmado/i, "stale_xlsx"],
  [/Target closed|context.*destroy|browser.*disconnect|Protocol error|page crash/i, "transient_ui"],
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

/**
 * Calculates backoff delay in ms for a given attempt number.
 * Uses exponential backoff: base * 2^(attempt-1), capped at maxDelay.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number = 5000,
  maxMs: number = 60000,
): number {
  const delay = baseMs * Math.pow(2, attempt - 1);
  return Math.min(delay, maxMs);
}
