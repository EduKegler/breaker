/** Throws if value is NaN or Infinity. Use for data that MUST be valid. */
export function finiteOrThrow(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${label}: expected finite number, got ${value}`);
  }
  return value;
}
