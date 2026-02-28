export interface ExecutionConfig {
  slippageBps: number; // basis points, e.g. 2 = 0.02%
  commissionPct: number; // percentage, e.g. 0.045 = 0.045%
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  slippageBps: 2,
  commissionPct: 0.045,
};
