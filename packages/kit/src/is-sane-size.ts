/** Safety-net range check for sizes. */
export function isSaneSize(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < 1_000_000;
}
