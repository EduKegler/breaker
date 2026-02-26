import type { Guardrails } from "../types/config.js";

export interface RiskCheckInput {
  notionalUsd: number;
  leverage: number;
  openPositions: number;
  dailyLossUsd: number;
  tradesToday: number;
}

export interface RiskCheckResult {
  passed: boolean;
  reason: string | null;
}

export function checkRisk(input: RiskCheckInput, guardrails: Guardrails): RiskCheckResult {
  if (input.notionalUsd > guardrails.maxNotionalUsd) {
    return { passed: false, reason: `Notional $${input.notionalUsd} exceeds max $${guardrails.maxNotionalUsd}` };
  }

  if (input.leverage > guardrails.maxLeverage) {
    return { passed: false, reason: `Leverage ${input.leverage}x exceeds max ${guardrails.maxLeverage}x` };
  }

  if (input.openPositions >= guardrails.maxOpenPositions) {
    return { passed: false, reason: `Open positions ${input.openPositions} >= max ${guardrails.maxOpenPositions}` };
  }

  if (input.dailyLossUsd >= guardrails.maxDailyLossUsd) {
    return { passed: false, reason: `Daily loss $${input.dailyLossUsd} >= max $${guardrails.maxDailyLossUsd}` };
  }

  if (input.tradesToday >= guardrails.maxTradesPerDay) {
    return { passed: false, reason: `Trades today ${input.tradesToday} >= max ${guardrails.maxTradesPerDay}` };
  }

  return { passed: true, reason: null };
}
