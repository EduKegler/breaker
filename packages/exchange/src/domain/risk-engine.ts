import type { Guardrails } from "../types/config.js";

// Code-level safety net — cannot be overridden by config.
// Catches config mistakes before they become catastrophic positions.
const ABSOLUTE_MAX_NOTIONAL_USD = 100_000;

// Entry price must be within 5% of current market price.
// Prevents stale signals or fat-finger entries from executing.
const MAX_PRICE_DEVIATION_PCT = 0.05;

export interface RiskCheckInput {
  notionalUsd: number;
  leverage: number;
  openPositions: number;
  dailyLossUsd: number;
  tradesToday: number;
  entryPrice?: number;
  currentPrice?: number;
}

export interface RiskCheckResult {
  passed: boolean;
  reason: string | null;
}

export function checkRisk(input: RiskCheckInput, guardrails: Guardrails): RiskCheckResult {
  // Absolute hardcoded cap — first check, independent of config
  if (input.notionalUsd > ABSOLUTE_MAX_NOTIONAL_USD) {
    return { passed: false, reason: `Notional $${input.notionalUsd} exceeds absolute cap $${ABSOLUTE_MAX_NOTIONAL_USD}` };
  }

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

  // Price sanity: reject if entry deviates too far from current market
  if (
    input.entryPrice != null &&
    input.currentPrice != null &&
    input.currentPrice > 0
  ) {
    const deviation = Math.abs(input.entryPrice - input.currentPrice) / input.currentPrice;
    if (deviation > MAX_PRICE_DEVIATION_PCT) {
      const pct = (deviation * 100).toFixed(1);
      return { passed: false, reason: `Entry price $${input.entryPrice} deviates ${pct}% from current $${input.currentPrice} (max ${MAX_PRICE_DEVIATION_PCT * 100}%)` };
    }
  }

  return { passed: true, reason: null };
}
