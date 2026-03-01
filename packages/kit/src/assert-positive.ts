/** Throws if value is not a positive finite number. */
export function assertPositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: expected positive number, got ${value}`);
  }
  return value;
}
