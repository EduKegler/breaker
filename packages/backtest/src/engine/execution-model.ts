export interface ExecutionConfig {
  slippageBps: number; // basis points, e.g. 10 = 0.10%
  commissionPct: number; // percentage, e.g. 0.045 = 0.045%
  fundingRate8h: number; // rate per 8h period, e.g. 0.0004 = 0.04%
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  slippageBps: 10,
  commissionPct: 0.045,
  fundingRate8h: 0.0004,
};
