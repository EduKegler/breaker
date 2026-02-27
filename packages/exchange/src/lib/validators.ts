/**
 * Guard functions for validating numeric data at system boundaries.
 * Applied in adapters to catch NaN/Infinity/absurd values from external sources
 * (SDK responses, WebSocket events, candle data) before they propagate.
 */

/** Throws if value is NaN or Infinity. Use for data that MUST be valid. */
export function finiteOrThrow(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label}: expected finite number, got ${value}`);
  }
  return value;
}

/** Returns fallback if value is NaN or Infinity. Use for optional/degradable fields. */
export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Throws if value is not a positive finite number. */
export function assertPositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: expected positive number, got ${value}`);
  }
  return value;
}

/** Safety-net range check for prices. Not business logic — catches absurd values. */
export function isSanePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 10_000_000;
}

/** Safety-net range check for sizes. */
export function isSaneSize(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < 1_000_000;
}

/** Safety-net range check for equity values. */
export function isSaneEquity(value: number): boolean {
  return Number.isFinite(value) && value > -1_000_000 && value < 100_000_000;
}
