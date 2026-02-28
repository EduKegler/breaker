/** Truncate price to 5 significant figures (SDK floatToWire requirement). */
export function truncatePrice(price: number): number {
  return Number(price.toPrecision(5));
}
