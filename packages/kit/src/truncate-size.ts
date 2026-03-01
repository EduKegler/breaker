/** Truncate size to exchange-allowed decimals (avoids floatToWire rounding error).
 *  Uses Math.floor so we never exceed available margin (buys) or position size (reduceOnly sells).
 *  Adds a tiny epsilon before floor to compensate for IEEE 754 representation errors
 *  (e.g. 0.00112 * 100000 = 111.9999... instead of 112). */
export function truncateSize(size: number, szDecimals: number): number {
  const factor = 10 ** szDecimals;
  return Math.floor(size * factor + 1e-9) / factor;
}
