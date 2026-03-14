import type { Guardrails } from "../../types/config.js";
import type { StrategyParam, WalkForward, RollingWalkForward } from "@breaker/backtest";

interface GuardrailViolation {
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
 * Validate walk-forward results for overfitting.
 * KB §10.1: overfitFlag → reject (strategy memorized training data).
 */
export function validateWalkForward(
  walkForward: WalkForward | null,
): GuardrailViolation[] {
  if (!walkForward) return [];
  if (!walkForward.overfitFlag) return [];

  const pfRatioStr = walkForward.pfRatio !== null ? walkForward.pfRatio.toFixed(2) : "N/A";
  const testPFStr = walkForward.testPF !== null ? walkForward.testPF.toFixed(2) : "N/A";
  const trainPFStr = walkForward.trainPF !== null ? walkForward.trainPF.toFixed(2) : "N/A";

  return [{
    field: "overfitFlag",
    reason: `Walk-forward overfit: trainPF=${trainPFStr}, testPF=${testPFStr}, pfRatio=${pfRatioStr}`,
  }];
}

/**
 * Validate rolling walk-forward results for overfitting.
 * Rolling WF splits data into multiple overlapping windows and checks each.
 * overfitFlag → reject (majority of windows show degradation).
 */
export function validateRollingWalkForward(
  rollingWf: RollingWalkForward | null,
): GuardrailViolation[] {
  if (!rollingWf) return [];
  if (!rollingWf.overfitFlag) return [];

  const failedWindows = rollingWf.windows.filter((w) => !w.pass);
  const failedDetails = failedWindows
    .map((w) => `win${w.windowIndex}(pfRatio=${w.pfRatio?.toFixed(2) ?? "N/A"})`)
    .join(", ");

  return [{
    field: "rollingWfOverfit",
    reason: `Rolling WF overfit: ${rollingWf.windowsPassed}/${rollingWf.windowsTotal} passed (${(rollingWf.passRate * 100).toFixed(0)}%), failed=[${failedDetails}]`,
  }];
}

/**
 * Validate win rate against archetype-specific max threshold.
 * Detects archetype drift (e.g., breakout strategy with 70% WR ≈ scalping).
 */
export function validateArchetypeWR(
  winRate: number,
  wrRejectMax: number | null,
): GuardrailViolation[] {
  if (wrRejectMax === null) return [];
  if (winRate <= wrRejectMax) return [];
  return [{
    field: "archetypeWR",
    reason: `Archetype drift: WR ${winRate.toFixed(1)}% exceeds max ${wrRejectMax}% for this module`,
  }];
}

/**
 * Validate that optimizable param count doesn't exceed maxFreeVariables.
 * KB §13.1: hard gate — reject strategies exceeding profile limit.
 */
export function validateFreeVariableCount(
  paramCount: number,
  maxFreeVariables: number | undefined,
): GuardrailViolation[] {
  if (maxFreeVariables === undefined) return [];
  if (paramCount <= maxFreeVariables) return [];
  return [{
    field: "freeVariables",
    reason: `Exceeds max free variables: ${paramCount} > ${maxFreeVariables}`,
  }];
}

/**
 * Legacy guardrail validation.
 * Validates strategy edits (for backward compat during restructure phase).
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

/**
 * Validate that strategy source still contains ctx.track() calls.
 * Restructure must not strip diagnostic tracking from onCandle().
 */
export function validateDiagnosticTracking(
  afterSource: string,
): GuardrailViolation[] {
  const clean = stripComments(afterSource);
  if (!clean.includes("ctx.track(")) {
    return [{
      field: "diagnostics",
      reason: "Strategy source missing ctx.track() calls — diagnostics stripped",
    }];
  }
  return [];
}

/**
 * Validate that strategy source retains all mandatory structural patterns.
 * These are methods/patterns present in ALL strategies that the refiner/restructure
 * must never strip — they fail silently (code compiles but behavior degrades).
 *
 * Checks:
 * 1. ctx.track() — diagnostic tracking (same as validateDiagnosticTracking)
 * 2. computeLevels — required by /quick-signal for manual signals
 * 3. shouldExit — position exit logic (timeout + trailing)
 * 4. requiredTimeframes — tells runner which HTF candles to load
 * 5. Anti-repaint HTF — completed-bar check (.t + MS_* <= currentCandle.t)
 */
export function validateStrategyStructure(
  afterSource: string,
): GuardrailViolation[] {
  const clean = stripComments(afterSource);
  const violations: GuardrailViolation[] = [];

  if (!clean.includes("ctx.track(")) {
    violations.push({
      field: "diagnostics",
      reason: "Strategy source missing ctx.track() calls — diagnostics stripped",
    });
  }

  if (!clean.includes("computeLevels")) {
    violations.push({
      field: "computeLevels",
      reason: "Strategy missing computeLevels() — manual signals (/quick-signal) will break",
    });
  }

  if (!clean.includes("shouldExit")) {
    violations.push({
      field: "shouldExit",
      reason: "Strategy missing shouldExit() — positions will only exit by SL/TP, no timeout or trailing",
    });
  }

  if (!clean.includes("requiredTimeframes")) {
    violations.push({
      field: "requiredTimeframes",
      reason: "Strategy missing requiredTimeframes — runner won't load HTF candles",
    });
  }

  // Anti-repaint: strategies must check HTF bar completion via .t + MS_1H/4H/1D
  // Accept inline pattern OR mapHtfToSource helper (which guarantees anti-repaint internally)
  if (!/\.t\s*\+\s*MS_/.test(clean) && !/mapHtfToSource/.test(clean)) {
    violations.push({
      field: "antiRepaint",
      reason: "Strategy missing HTF anti-repaint check (.t + MS_* <= currentCandle.t) — may use incomplete bars",
    });
  }

  return violations;
}

/**
 * Validate that both PF and avgR haven't regressed vs the best checkpoint.
 * When BOTH worsen, the strategy has objectively degraded even if score improved
 * (e.g., trade count increase boosting sampleConfidence while edge erodes).
 */
export function validateProfitabilityRegression(
  newMetrics: { profitFactor: number | null; avgR: number | null },
  bestMetrics: { profitFactor: number | null; avgR: number | null },
): GuardrailViolation[] {
  const newPF = newMetrics.profitFactor ?? 0;
  const bestPF = bestMetrics.profitFactor ?? 0;
  const newAvgR = newMetrics.avgR ?? 0;
  const bestAvgR = bestMetrics.avgR ?? 0;

  if (newPF < bestPF && newAvgR < bestAvgR) {
    return [{
      field: "profitabilityRegression",
      reason: `Both PF and avgR worsened: PF ${bestPF.toFixed(2)}→${newPF.toFixed(2)}, avgR ${bestAvgR.toFixed(3)}→${newAvgR.toFixed(3)}`,
    }];
  }
  return [];
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

function extractStrategyCategory(code: string): string | null {
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
