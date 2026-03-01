/** Truncate size to exchange-allowed decimals (avoids floatToWire rounding error).
 *  Uses Math.floor so we never exceed available margin (buys) or position size (reduceOnly sells). */
export function truncateSize(size: number, szDecimals: number): number {
  const factor = 10 ** szDecimals;
  return Math.floor(size * factor) / factor;
}
