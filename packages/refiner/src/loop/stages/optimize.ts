import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execaSync } from "execa";
import writeFileAtomic from "write-file-atomic";
import type { StageResult } from "../types.js";
import { runClaude } from "./run-claude.js";
import { safeJsonParse } from "../../lib/safe-json.js";
import type { ModuleContext } from "../../lib/build-module-context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OptimizeResult {
  changed: boolean;
  diff?: string;
  changeScale?: "parametric" | "structural";
  paramOverrides?: Record<string, number>;
  validationWarnings?: string[];
  /** Claude's SUMMARY line — always extracted when available */
  summary?: string;
}

/**
 * Per-module param constraints derived from KB fixed rules.
 * Keys = param names used in strategy configs.
 * Values = { min, max } inclusive range.
 *
 * These MUST stay in sync with the KB (sections 3-6, 1.6).
 * If the KB changes a range, update here.
 */
interface ParamConstraint {
  min?: number;
  max?: number;
  /** Hard floor that cannot be violated (e.g. ATR mult >= 3.0 for M4) */
  hardFloor?: number;
  /** Hard ceiling */
  hardCeiling?: number;
}

const MODULE_CONSTRAINTS: Record<string, Record<string, ParamConstraint>> = {
  M1: {
    // Breakout — 8 var cap, ATR 1H stop, KB §1.6 min mult 3.0
    // Aligned with donchian-adx.ts DEFAULT_PARAMS
    bbKcPeriod:        { min: 14, max: 30 },
    kcMult:            { min: 1.0, max: 2.5 },
    bbStdDev:          { min: 1.5, max: 2.5 },
    atrStopMult:       { min: 3.0, hardFloor: 3.0, max: 5.0 },
    volMult:           { min: 1.0, max: 3.0 },
    tpRR:              { min: 1.0, max: 4.0 },
    trailMult:         { min: 2.0, max: 5.0 },
    timeoutBars:       { min: 24, max: 96 },
  },
  M2: {
    // Mean Reversion — 6 var cap, ATR 1H wide/catastrophic stop, KB §1.6 min mult 3.0
    kcPeriod:          { min: 10, max: 30 },
    kcMultiplier:      { min: 1.0, max: 3.0 },
    rsi2Long:          { min: 5, max: 25 },
    rsi2Short:         { min: 75, max: 95 },
    adxThreshold:      { min: 15, max: 35 },
    timeoutBars:       { min: 8, max: 48 },
    stopAtrMult:       { min: 3.0, max: 5.0 },
  },
  M3: {
    // Pullback — 8 var cap, ATR 1H stop as entry filter, KB §1.6 min mult 2.5
    emaPeriod:         { min: 20, max: 200 },
    fibUpper:          { min: 38.2, max: 78.6 },
    fibLower:          { min: 23.6, max: 61.8 },
    rsiPeriod:         { min: 7, max: 21 },
    rsiThreshold:      { min: 30, max: 60 },
    stopAtrMult:       { min: 2.5, hardFloor: 2.5, max: 4.0 },
    timeoutBars:       { min: 16, max: 64 },
  },
  M4: {
    // Trend Following — 6 var cap, Daily ATR stop >= 3.0
    superTrendAtrPeriod: { min: 7, max: 20 },
    superTrendMult:      { min: 2.0, max: 5.0 },
    adxThreshold:        { min: 20, max: 35 },
    stopAtrMult:         { min: 3.0, hardFloor: 3.0, max: 8.0 },
    timeoutDays:         { min: 10, max: 30 },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function log(msg: string): void {
  console.log(`\x1b[2m${ts()}\x1b[0m ${msg}`);
}

const paramOverridesSchema = z.object({
  paramOverrides: z.record(z.string(), z.number()),
});

/**
 * Extract the SUMMARY line from Claude's output.
 * Looks for `SUMMARY: <text>` marker (case-insensitive).
 * Falls back to last substantive lines if marker not found.
 */
function extractSummary(text: string, maxLen = 200): string {
  // Look for SUMMARY: marker (last occurrence wins, in case Claude outputs multiple)
  const matches = text.match(/^SUMMARY:\s*(.+)$/gim);
  if (matches && matches.length > 0) {
    const last = matches[matches.length - 1];
    const content = last.replace(/^SUMMARY:\s*/i, "").trim();
    return content.length > maxLen ? content.slice(0, maxLen) : content;
  }
  // Fallback: last substantive lines
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return "(empty output)";
  const tail = lines.slice(-3).join(" ");
  return tail.length > maxLen ? tail.slice(-maxLen) : tail;
}

/**
 * Extract paramOverrides JSON from Claude's text output.
 */
function extractParamOverrides(text: string): Record<string, number> | null {
  // Try JSON code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?"paramOverrides"[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = safeJsonParse(codeBlockMatch[1], { repair: true, schema: paramOverridesSchema });
      return parsed.paramOverrides;
    } catch { /* try next pattern */ }
  }

  // Try inline JSON
  const inlineMatch = text.match(/\{\s*"paramOverrides"\s*:\s*\{[^}]*\}\s*\}/);
  if (inlineMatch) {
    try {
      const parsed = safeJsonParse(inlineMatch[0], { repair: true, schema: paramOverridesSchema });
      return parsed.paramOverrides;
    } catch { /* ignore */ }
  }

  // Fallback: extract "paramName oldValue→newValue" from SUMMARY line
  const summaryMatch = text.match(/^SUMMARY:\s*(.+)$/im);
  if (summaryMatch) {
    const summaryLine = summaryMatch[1];
    // Match patterns like "tpRR 2→1.5", "volMult 1.5 -> 2.0", or "bbKcPeriod=20→14"
    const paramChanges = [...summaryLine.matchAll(/(\w+)[=\s]+[\d.]+\s*(?:→|->)\s*([\d.]+)/g)];
    if (paramChanges.length > 0) {
      const result: Record<string, number> = {};
      for (const m of paramChanges) {
        result[m[1]] = parseFloat(m[2]);
      }
      return result;
    }
  }

  return null;
}

/**
 * Validate param overrides against KB-derived constraints.
 * Returns { valid, clamped, warnings }.
 * - valid: params that pass all checks
 * - clamped: params that were adjusted to fit within range
 * - warnings: human-readable messages about what was adjusted/rejected
 */
function validateParamOverrides(
  overrides: Record<string, number>,
  moduleId: string,
  varCap: number,
  existingParamCount: number,
): { valid: Record<string, number>; warnings: string[] } {
  const constraints = MODULE_CONSTRAINTS[moduleId] ?? {};
  const warnings: string[] = [];
  const valid: Record<string, number> = {};

  // Count total vars: existing + new ones not already counted
  let newParamCount = 0;

  for (const [key, value] of Object.entries(overrides)) {
    const constraint = constraints[key];

    // Check if this is a new param (not in existing config)
    // For now, assume all overrides are existing params being tuned.
    // If a key is unknown, flag it.
    if (!constraint) {
      // Param not in MODULE_CONSTRAINTS — expected for seed/variant strategies
      // whose params differ from the deployed strategy. Accept silently.
      valid[key] = value;
      newParamCount++;
      continue;
    }

    let adjustedValue = value;

    // Hard floor check (KB rule violation — reject or clamp)
    if (constraint.hardFloor !== undefined && value < constraint.hardFloor) {
      warnings.push(
        `REJECTED "${key}": ${value} violates hard floor ${constraint.hardFloor} (KB fixed rule). Clamped to ${constraint.hardFloor}.`,
      );
      adjustedValue = constraint.hardFloor;
    }

    // Hard ceiling check
    if (constraint.hardCeiling !== undefined && value > constraint.hardCeiling) {
      warnings.push(
        `REJECTED "${key}": ${value} violates hard ceiling ${constraint.hardCeiling} (KB fixed rule). Clamped to ${constraint.hardCeiling}.`,
      );
      adjustedValue = constraint.hardCeiling;
    }

    // Soft range check (warn + clamp)
    if (constraint.min !== undefined && adjustedValue < constraint.min) {
      warnings.push(`Clamped "${key}": ${adjustedValue} below range min ${constraint.min}. Set to ${constraint.min}.`);
      adjustedValue = constraint.min;
    }
    if (constraint.max !== undefined && adjustedValue > constraint.max) {
      warnings.push(`Clamped "${key}": ${adjustedValue} above range max ${constraint.max}. Set to ${constraint.max}.`);
      adjustedValue = constraint.max;
    }

    valid[key] = adjustedValue;
  }

  // Var count check
  const totalVars = existingParamCount + newParamCount;
  if (totalVars > varCap) {
    warnings.push(
      `VAR CAP EXCEEDED: ${totalVars} vars (cap: ${varCap}). ${newParamCount} new params introduced. Some may need to be dropped.`,
    );
  }

  return { valid, warnings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function optimizeStrategy(opts: {
  prompt: string;
  strategyFile: string;
  repoRoot: string;
  model: string;
  phase: string;
  artifactsDir: string;
  globalIter: number;
  moduleContext: ModuleContext;
  existingParamCount: number;
  timeoutMs?: number;
  cancelSignal?: AbortSignal;
}): Promise<StageResult<OptimizeResult>> {
  const {
    prompt, strategyFile, repoRoot, model, phase,
    artifactsDir, globalIter, moduleContext,
    existingParamCount, timeoutMs = 900000, cancelSignal,
  } = opts;

  try {
    const beforeContent = fs.readFileSync(strategyFile, "utf8");
    const maxTurns = phase === "restructure" ? 25 : 12;
    log(`  [optimize] phase: ${phase}, model: ${model}, max-turns: ${maxTurns}, module: ${moduleContext.moduleId}`);

    const result = await runClaude(
      ["--model", model, "--dangerously-skip-permissions", "--max-turns", String(maxTurns), "-p", prompt],
      { cwd: repoRoot, timeoutMs, label: "optimize", cancelSignal },
    );

    if (result.status !== 0) {
      if (result.stdout) log(`  [optimize] stdout (last 500): ${result.stdout.slice(-500)}`);
      if (result.stderr) log(`  [optimize] stderr (last 500): ${result.stderr.slice(-500)}`);
      return {
        success: false,
        error: `Claude CLI exited with code ${result.status}: ${result.stderr?.slice(0, 500)}`,
      };
    }

    const afterContent = fs.readFileSync(strategyFile, "utf8");
    const fileChanged = beforeContent !== afterContent;

    // Detect max-turns hit during restructure: file may be partially modified.
    // Revert to prevent accepting incomplete edits.
    const maxTurnsHit = /max.turns.*reached|max turns/i.test(result.stdout + (result.stderr ?? ""));
    if (maxTurnsHit && fileChanged && phase !== "refine") {
      log(`  [optimize] max-turns reached during ${phase} — reverting partial file changes`);
      writeFileAtomic.sync(strategyFile, beforeContent, "utf8");
      return {
        success: true,
        data: {
          changed: false,
          summary: extractSummary(result.stdout),
        },
      };
    }

    // -----------------------------------------------------------------
    // Refine phase: extract and VALIDATE paramOverrides
    // -----------------------------------------------------------------

    if (phase === "refine") {
      // Safety: if file changed during refine (unexpected), revert
      if (fileChanged) {
        log(`  [optimize] WARNING: file changed during refine phase — reverting`);
        writeFileAtomic.sync(strategyFile, beforeContent, "utf8");
      }

      const paramOverrides = extractParamOverrides(result.stdout);
      if (!paramOverrides || Object.keys(paramOverrides).length === 0) {
        return {
          success: true,
          data: {
            changed: false,
            summary: extractSummary(result.stdout),
          },
        };
      }

      // KB §13.1: refine must change at most 1 param per iteration
      const overrideKeys = Object.keys(paramOverrides);
      if (overrideKeys.length > 1) {
        log(`  [optimize] Refine produced ${overrideKeys.length} param changes — keeping only first (${overrideKeys[0]})`);
        const firstKey = overrideKeys[0];
        for (const k of overrideKeys) {
          if (k !== firstKey) delete paramOverrides[k];
        }
      }

      // Validate against KB constraints
      const { valid, warnings } = validateParamOverrides(
        paramOverrides,
        moduleContext.moduleId,
        moduleContext.varCap,
        existingParamCount,
      );

      // 3a: Param validation summary
      const accepted = Object.keys(valid).length;
      const clamped = warnings.filter((w) => w.startsWith("Clamped")).length;
      const rejected = warnings.filter((w) => w.startsWith("REJECTED")).length;
      log(`  [optimize] Param validation: ${accepted} accepted, ${clamped} clamped, ${rejected} rejected`);

      if (warnings.length > 0) {
        log(`  [optimize] Validation warnings:\n${warnings.map((w) => `    - ${w}`).join("\n")}`);
      }

      // Write validation log for audit trail
      const validationLogPath = path.join(artifactsDir, `iter${globalIter}-validation.json`);
      try {
        writeFileAtomic.sync(validationLogPath, JSON.stringify({
          phase,
          moduleId: moduleContext.moduleId,
          rawOverrides: paramOverrides,
          validatedOverrides: valid,
          warnings,
          timestamp: new Date().toISOString(),
        }, null, 2), "utf8");
      } catch { /* non-critical */ }

      return {
        success: true,
        data: {
          changed: Object.keys(valid).length > 0,
          changeScale: "parametric",
          paramOverrides: valid,
          validationWarnings: warnings.length > 0 ? warnings : undefined,
          summary: extractSummary(result.stdout),
        },
      };
    }

    // -----------------------------------------------------------------
    // Restructure phase: check if file changed, typecheck
    // -----------------------------------------------------------------

    if (!fileChanged) {
      return {
        success: true,
        data: {
          changed: false,
          summary: extractSummary(result.stdout),
        },
      };
    }

    // Typecheck the modified strategy
    try {
      execaSync("pnpm", ["--filter", "@breaker/backtest", "typecheck"], {
        cwd: repoRoot,
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      log("  [optimize] Typecheck passed");
    } catch (err) {
      const errMsg = (err as { stderr?: string }).stderr ?? (err as Error).message;
      log(`  [optimize] Typecheck FAILED: ${errMsg.slice(0, 300)}`);
      writeFileAtomic.sync(strategyFile, beforeContent, "utf8");
      return {
        success: false,
        error: `typecheck_error: ${errMsg.slice(0, 500)}`,
        errorClass: "compile_error",
      };
    }

    // Diff for audit trail
    let diff: string | undefined;
    try {
      const diffResult = execaSync("git", ["diff", "--no-color", strategyFile], {
        cwd: repoRoot,
        timeout: 5000,
      });
      diff = diffResult.stdout;
    } catch {
      diff = "(diff unavailable)";
    }

    // Determine changeScale from metadata (Claude-written, best-effort)
    const iterMetadataSchema = z.object({
      changeApplied: z.object({ scale: z.string() }).passthrough().nullable().optional(),
    }).passthrough();

    let changeScale: "parametric" | "structural" | undefined;
    try {
      const metaPath = path.join(artifactsDir, `iter${globalIter}-metadata.json`);
      if (fs.existsSync(metaPath)) {
        const meta = safeJsonParse(
          fs.readFileSync(metaPath, "utf8"),
          { repair: true, schema: iterMetadataSchema },
        );
        changeScale = meta.changeApplied?.scale as "parametric" | "structural" | undefined;
      }
    } catch { /* ignore */ }

    return {
      success: true,
      data: { changed: true, diff, changeScale: changeScale ?? "structural", summary: extractSummary(result.stdout) },
    };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message || "optimize failed",
    };
  }
}