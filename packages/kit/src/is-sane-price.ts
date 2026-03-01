/** Safety-net range check for prices. Not business logic -- catches absurd values. */
export function isSanePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < 10_000_000;
}
