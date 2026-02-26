export interface ExecutionConfig {
  slippageBps: number; // basis points, e.g. 2 = 0.02%
  commissionPct: number; // percentage, e.g. 0.045 = 0.045%
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  slippageBps: 2,
  commissionPct: 0.045,
};

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
