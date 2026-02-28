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
