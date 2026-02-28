/** Returns fallback if value is NaN or Infinity. Use for optional/degradable fields. */
export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
