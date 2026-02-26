import type { Guardrails } from "../../types/config.js";
import type { StrategyParam } from "@breaker/backtest";

export interface GuardrailViolation {
  field: string;
  reason: string;
}

/**
 * Validate that strategy param changes don't violate guardrails.
 * Works with typed StrategyParam objects instead of Pine regex.
 */
export function validateParamGuardrails(
  beforeParams: Record<string, StrategyParam>,
  afterParams: Record<string, StrategyParam>,
  guardrails: Guardrails,
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  // Check protected fields
  for (const field of guardrails.protectedFields) {
    const beforeVal = beforeParams[field]?.value;
    const afterVal = afterParams[field]?.value;
    if (beforeVal !== undefined && afterVal !== undefined && beforeVal !== afterVal) {
      violations.push({
        field,
        reason: `Protected field changed: ${beforeVal} → ${afterVal}`,
      });
    }
  }

  // Check atrStopMult / atrMult bounds
  const atrMultNames = ["atrStopMult", "atrMult", "slAtrMult"];
  for (const name of atrMultNames) {
    const afterVal = afterParams[name]?.value;
    if (afterVal === undefined) continue;

    if (guardrails.maxAtrMult && afterVal > guardrails.maxAtrMult) {
      violations.push({
        field: name,
        reason: `Exceeds max: ${afterVal} > ${guardrails.maxAtrMult}`,
      });
    }
    if (guardrails.minAtrMult && afterVal < guardrails.minAtrMult) {
      violations.push({
        field: name,
        reason: `Below min: ${afterVal} < ${guardrails.minAtrMult}`,
      });
    }
  }

  // Validate params stay within their declared min/max bounds
  for (const [name, param] of Object.entries(afterParams)) {
    if (param.value < param.min) {
      violations.push({
        field: name,
        reason: `Below declared min: ${param.value} < ${param.min}`,
      });
    }
    if (param.value > param.max) {
      violations.push({
        field: name,
        reason: `Above declared max: ${param.value} > ${param.max}`,
      });
    }
  }

  return violations;
}

/**
 * Legacy Pine guardrail validation.
 * Validates Pine Script edits (for backward compat during restructure phase).
 */
export function validateGuardrails(
  before: string,
  after: string,
  guardrails: Guardrails,
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  const beforeClean = stripComments(before);
  const afterClean = stripComments(after);

  for (const field of guardrails.protectedFields) {
    const beforeVal = extractFieldValue(beforeClean, field);
    const afterVal = extractFieldValue(afterClean, field);
    if (beforeVal !== null && afterVal !== null && beforeVal !== afterVal) {
      violations.push({
        field,
        reason: `Protected field changed: "${beforeVal}" → "${afterVal}"`,
      });
    }
  }

  const riskAfter = extractNumericVar(afterClean, "riskTradeUsd");
  if (riskAfter !== null && riskAfter > guardrails.maxRiskTradeUsd) {
    violations.push({
      field: "riskTradeUsd",
      reason: `Exceeds max: ${riskAfter} > ${guardrails.maxRiskTradeUsd}`,
    });
  }

  if (guardrails.maxAtrMult) {
    const atrMultAfter = extractNumericVar(afterClean, "atrMult");
    if (atrMultAfter !== null && atrMultAfter > guardrails.maxAtrMult) {
      violations.push({
        field: "atrMult",
        reason: `Exceeds max: ${atrMultAfter} > ${guardrails.maxAtrMult}`,
      });
    }
  }

  if (guardrails.minAtrMult) {
    const atrMultAfter = extractNumericVar(afterClean, "atrMult");
    if (atrMultAfter !== null && atrMultAfter < guardrails.minAtrMult) {
      violations.push({
        field: "atrMult",
        reason: `Below min: ${atrMultAfter} < ${guardrails.minAtrMult}`,
      });
    }
  }

  return violations;
}

function extractFieldValue(code: string, field: string): string | null {
  const patterns = [
    new RegExp(`${escapeRegex(field)}\\s*=\\s*([^\\s,)]+)`),
    new RegExp(`${escapeRegex(field)}\\s*:\\s*([^\\s,)]+)`),
  ];
  for (const pat of patterns) {
    const m = code.match(pat);
    if (m) return m[1];
  }
  return null;
}

function extractNumericVar(code: string, varName: string): number | null {
  const m = code.match(new RegExp(`${escapeRegex(varName)}\\s*=\\s*([\\d.]+)`));
  if (!m) return null;
  const val = parseFloat(m[1]);
  return isNaN(val) ? null : val;
}

function stripComments(code: string): string {
  return code
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

export function countDayOfWeekUsage(code: string): number {
  return (code.match(/\bdayofweek\b/gi) || []).length;
}

export function extractStrategyCategory(code: string): string | null {
  const m = code.match(/strategy\s*\(\s*"([^"]+)"/);
  if (!m) return null;
  const title = m[1];
  const parts = title.split(/\s*[—]\s*|\s+--\s+/);
  if (parts.length < 2) return null;
  const prefix = parts[0].trim();
  const words = prefix.split(/\s+/);
  return words.length > 2 ? words.slice(2).join(" ").toLowerCase() : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
