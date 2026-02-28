/**
 * Calculate commission for a fill.
 */
export function calculateCommission(
  price: number,
  size: number,
  commissionPct: number,
): number {
  return Math.abs(price * size) * (commissionPct / 100);
}
