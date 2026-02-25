import type { Guardrails } from "../../types/config.js";

export interface GuardrailViolation {
  field: string;
  reason: string;
}

/**
 * Validate that a Pine Script edit didn't violate guardrails.
 * Compares before/after to detect forbidden changes.
 */
export function validateGuardrails(
  before: string,
  after: string,
  guardrails: Guardrails,
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  // Strip comments to avoid matching values in commented-out code
  const beforeClean = stripComments(before);
  const afterClean = stripComments(after);

  // Check protected fields
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

  // Check riskTradeUsd cap
  const riskAfter = extractNumericVar(afterClean, "riskTradeUsd");
  if (riskAfter !== null && riskAfter > guardrails.maxRiskTradeUsd) {
    violations.push({
      field: "riskTradeUsd",
      reason: `Exceeds max: ${riskAfter} > ${guardrails.maxRiskTradeUsd}`,
    });
  }

  // Check atrMult cap (prevents disabling stop loss with absurd values)
  if (guardrails.maxAtrMult) {
    const atrMultAfter = extractNumericVar(afterClean, "atrMult");
    if (atrMultAfter !== null && atrMultAfter > guardrails.maxAtrMult) {
      violations.push({
        field: "atrMult",
        reason: `Exceeds max: ${atrMultAfter} > ${guardrails.maxAtrMult}`,
      });
    }
  }

  // Check atrMult floor (prevents tight stops where fees eat the edge)
  if (guardrails.minAtrMult) {
    const atrMultAfter = extractNumericVar(afterClean, "atrMult");
    if (atrMultAfter !== null && atrMultAfter < guardrails.minAtrMult) {
      violations.push({
        field: "atrMult",
        reason: `Below min: ${atrMultAfter} < ${guardrails.minAtrMult}`,
      });
    }
  }

  // Check strategy.exit count didn't decrease (ignore commented lines)
  const beforeExits = countPattern(stripComments(before), /strategy\.exit\s*\(/g);
  const afterExits = countPattern(stripComments(after), /strategy\.exit\s*\(/g);
  if (afterExits < beforeExits) {
    violations.push({
      field: "strategy.exit",
      reason: `Exit count decreased: ${beforeExits} → ${afterExits}`,
    });
  }

  // Check dayofweek usage didn't increase (no persistent DOW edge in crypto 15m)
  const beforeDowCount = countDayOfWeekUsage(beforeClean);
  const afterDowCount = countDayOfWeekUsage(afterClean);
  if (afterDowCount > beforeDowCount) {
    violations.push({
      field: "dayofweek",
      reason: `Day-of-week usage increased: ${beforeDowCount} → ${afterDowCount}. Forbidden in crypto 15m.`,
    });
  }

  // Check strategy category hasn't changed (e.g. breakout → trend-continuation)
  const beforeCategory = extractStrategyCategory(beforeClean);
  const afterCategory = extractStrategyCategory(afterClean);
  if (beforeCategory && afterCategory && beforeCategory !== afterCategory) {
    violations.push({
      field: "strategy()",
      reason: `Strategy category changed: "${beforeCategory}" → "${afterCategory}". Category must match the directory (breakout, mean-reversion, etc.).`,
    });
  }

  return violations;
}

function extractFieldValue(code: string, field: string): string | null {
  // Match patterns like: field = value or field: value in strategy() call
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

function countPattern(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
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

/**
 * Extract the strategy category from the strategy() title.
 * Convention: strategy("ASSET TF Category — Name", ...)
 * Returns the category portion (e.g. "Breakout", "Mean-Reversion").
 */
export function extractStrategyCategory(code: string): string | null {
  // Match strategy("...") title — handles both em-dash and regular dash
  const m = code.match(/strategy\s*\(\s*"([^"]+)"/);
  if (!m) return null;
  const title = m[1];
  // Split on em-dash (—) or double-dash (--)
  const parts = title.split(/\s*[—]\s*|\s+--\s+/);
  if (parts.length < 2) return null;
  // Category is the last word(s) before the dash: "BTC 15m Breakout" → "Breakout"
  const prefix = parts[0].trim();
  const words = prefix.split(/\s+/);
  // Category is everything after asset + timeframe (first 2 words)
  return words.length > 2 ? words.slice(2).join(" ").toLowerCase() : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
