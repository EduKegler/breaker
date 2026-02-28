/**
 * Apply slippage to a fill price.
 * Buy orders slip up, sell orders slip down.
 */
export function applySlippage(
  price: number,
  side: "buy" | "sell",
  slippageBps: number,
): number {
  const mult = slippageBps / 10_000;
  return side === "buy" ? price * (1 + mult) : price * (1 - mult);
}
