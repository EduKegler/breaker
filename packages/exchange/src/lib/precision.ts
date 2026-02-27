/** Truncate size to exchange-allowed decimals (avoids floatToWire rounding error).
 *  Uses Math.floor so we never exceed available margin (buys) or position size (reduceOnly sells). */
export function truncateSize(size: number, szDecimals: number): number {
  const factor = 10 ** szDecimals;
  return Math.floor(size * factor) / factor;
}

/** Truncate price to 5 significant figures (SDK floatToWire requirement). */
export function truncatePrice(price: number): number {
  return Number(price.toPrecision(5));
}
