/** Safety-net range check for equity values. */
export function isSaneEquity(value: number): boolean {
  return Number.isFinite(value) && value > -1_000_000 && value < 100_000_000;
}
